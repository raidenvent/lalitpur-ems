import app from "../backend-files/backend/src/server.js";

// Vercel invokes the Express application as a serverless function. The
// rewrite in vercel.json keeps every /api/* endpoint on this one function.
export default app;
