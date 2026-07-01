import { Router } from "express";
import { z } from "zod";
import { BadRequestError } from "@/error/http";

export const router = Router();

const ImageProxyQuerySchema = z.object({
	url: z.string().min(1),
});

const TRUSTED_IMAGE_HOSTS = new Set([
	"lh3.googleusercontent.com",
	"avatars.githubusercontent.com",
	"github.com",
]);
const TRUSTED_IMAGE_TYPES = new Set([
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;

router.get("/utils/image-proxy", async (req, res) => {
	const { url: rawUrl } = ImageProxyQuerySchema.parse(req.query);
	const url = parseTrustedImageUrl(rawUrl);

	const response = await fetchTrustedImage(url);

	if (!response.ok) {
		throw new BadRequestError("Image could not be loaded.");
	}

	const contentType = (response.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (!TRUSTED_IMAGE_TYPES.has(contentType)) {
		throw new BadRequestError("URL is not an image.");
	}

	const contentLength = Number(response.headers.get("content-length") ?? "0");
	if (contentLength > MAX_IMAGE_BYTES) {
		throw new BadRequestError("Image is too large.");
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new BadRequestError("Image is too large.");
	}

	res.setHeader("Content-Type", contentType);
	res.setHeader("Content-Length", String(bytes.byteLength));
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader(
		"Cache-Control",
		"public, max-age=86400, stale-while-revalidate=604800",
	);
	res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
	res.end(Buffer.from(bytes));
});

async function fetchTrustedImage(rawUrl: string): Promise<Response> {
	let url = rawUrl;
	for (
		let redirectCount = 0;
		redirectCount <= MAX_IMAGE_REDIRECTS;
		redirectCount++
	) {
		const response = await fetch(url, {
			headers: {
				Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
				"User-Agent": "Shellular image proxy",
			},
			redirect: "manual",
		});

		if (!isRedirectResponse(response)) {
			return response;
		}

		const location = response.headers.get("location");
		if (!location) {
			throw new BadRequestError("Image redirect is invalid.");
		}

		url = parseTrustedImageUrl(new URL(location, url).toString());
	}

	throw new BadRequestError("Image redirected too many times.");
}

function isRedirectResponse(response: Response): boolean {
	return response.status >= 300 && response.status < 400;
}

function parseTrustedImageUrl(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new BadRequestError("Invalid image URL.");
	}

	if (url.protocol !== "https:") {
		throw new BadRequestError("Image URL must use HTTPS.");
	}
	if (!TRUSTED_IMAGE_HOSTS.has(url.hostname)) {
		throw new BadRequestError("Image host is not allowed.");
	}

	url.hash = "";
	return url.toString();
}
