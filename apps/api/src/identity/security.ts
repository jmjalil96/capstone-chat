export const identitySecurity = Object.freeze({
  authBodyLimitBytes: 16 * 1024,
  fakeMailboxRetention: 100,
  freshSessionSeconds: 15 * 60,
  rateLimitPersistenceWindowSeconds: 15 * 60,
  rateLimit: Object.freeze({
    ordinary: Object.freeze({ max: 100, window: 60 }),
    forgotPassword: Object.freeze({ max: 3, window: 15 * 60 }),
    resetPassword: Object.freeze({ max: 5, window: 15 * 60 }),
    signIn: Object.freeze({ max: 5, window: 60 }),
    verification: Object.freeze({ max: 10, window: 60 }),
    verificationResend: Object.freeze({ max: 3, window: 15 * 60 }),
  }),
  sessionExpiresInSeconds: 7 * 24 * 60 * 60,
  sessionUpdateAgeSeconds: 24 * 60 * 60,
  trustedProxy: false,
});
