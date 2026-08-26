/**
 * Domain errors carry their own status and machine-readable code. Routes throw;
 * the error middleware is the only place that knows how to turn one into a
 * response, so no route has to remember the envelope shape.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request', fields?: Record<string, string>) {
    super(400, 'bad_request', message, fields);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that', fields?: Record<string, string>) {
    super(403, 'forbidden', message, fields);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'not_found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Already exists', fields?: Record<string, string>) {
    super(409, 'conflict', message, fields);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many attempts. Try again shortly.') {
    super(429, 'too_many_requests', message);
  }
}
