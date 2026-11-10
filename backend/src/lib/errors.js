export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || `http_${status}`;
    this.details = details;
  }
}
export const badRequest = (m, details) => new HttpError(400, m, 'bad_request', details);
export const unauthorized = (m = 'Authentication required.') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have access to this resource.') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found.') => new HttpError(404, m, 'not_found');
export const conflict = (m, code) => new HttpError(409, m, code || 'conflict');
