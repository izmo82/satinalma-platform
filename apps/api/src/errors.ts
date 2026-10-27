export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export const notFound = () => new ApiError(404, 'not_found', 'Kayıt bulunamadı veya erişim yetkiniz yok.');
export const forbidden = (permission: string) => new ApiError(403, 'forbidden', `Bu işlem için yetkiniz yok (${permission}).`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new ApiError(422, code, message, details);
