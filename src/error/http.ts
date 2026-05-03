export class HttpError extends Error {
	statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export class BadRequestError extends HttpError {
	constructor(message: string) {
		super(400, message);
	}
}

export class TooManyRequestsError extends HttpError {
	constructor(message: string) {
		super(429, message);
	}
}

export class ConflictError extends HttpError {
	constructor(message: string) {
		super(409, message);
	}
}
