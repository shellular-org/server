import type express from "express";

import { logger } from "@/logger";

// Function to print all registered routes in a pretty format
export function printRoutes(app: ReturnType<typeof express>): void {
	logger.info("Registered Routes:");
	logger.info("─".repeat(60));

	const routeMap = new Map<string, string[]>();

	// Iterate through the router stack to collect routes (Express v5 compatible)
	const stack = app.router.stack;

	stack.forEach((middleware) => {
		if (middleware.route) {
			// Routes registered directly on the app
			const methods = Object.keys((middleware.route as any).methods)
				.filter((method) => (middleware.route as any).methods[method])
				.map((method) => method.toUpperCase());

			const path = middleware.route.path;
			if (!routeMap.has(path)) {
				routeMap.set(path, []);
			}
			routeMap.get(path)!.push(...methods);
		} else if (middleware.name === "router") {
			// Routes from mounted routers
			(middleware.handle as any).stack.forEach((handler: any) => {
				if (handler.route) {
					const methods = Object.keys(handler.route.methods)
						.filter((method) => handler.route.methods[method])
						.map((method) => method.toUpperCase());

					const paths = Array.isArray(handler.route.path)
						? handler.route.path
						: [handler.route.path];

					paths.forEach((path: string) => {
						if (!routeMap.has(path)) {
							routeMap.set(path, []);
						}

						routeMap.get(path)!.push(...methods);
					});
				}
			});
		}
	});

	// Remove duplicates from method arrays and sort
	for (const [path, methods] of routeMap) {
		const uniqueMethods = [...new Set(methods)].sort();
		routeMap.set(path, uniqueMethods);
	}

	// Sort routes by path for better readability
	const sortedRoutes = Array.from(routeMap.entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	// Print routes with their methods
	sortedRoutes.forEach(([path, methods]) => {
		logger.info(`${path}: [${methods.join(", ")}]`);
	});

	logger.info("─".repeat(60));
	logger.info(`Total routes: ${sortedRoutes.length}\n`);
}
