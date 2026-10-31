/** Small replacement-password guard, not a password-strength guarantee. */
export function replacementPasswordValid(username: string, password: string): boolean {
  return password.length >= 12 && password.length <= 128 &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(password) &&
    password.trim().toLowerCase() !== username.trim().toLowerCase() &&
    !/^(.)\1+$/us.test(password) &&
    !['passwordpassword', 'password1234', 'password123456', '123456789012', 'qwertyuiop123'].includes(password.toLowerCase())
}
