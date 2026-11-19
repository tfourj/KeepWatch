import { secureHeaders } from "hono/secure-headers";

/** Security headers for every response. The UI needs no inline scripts, so the CSP stays strict. */
export const securityHeaders = secureHeaders({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
});
