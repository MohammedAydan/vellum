/**
 * @vellum/auth — end-user authentication primitives.
 * Zero external native crypto dependencies: node:crypto plus nodemailer for mail.
 */

export * from "./contracts/auth-port.js";
export * from "./config-types.js";
export * from "./crypto/password.js";
export * from "./crypto/encrypt.js";
export * from "./crypto/jwt.js";
export * from "./realm-session.js";
export * from "./services/mfa-service.js";
export * from "./services/session-service.js";
export * from "./services/projector.js";
export * from "./mailer.js";
