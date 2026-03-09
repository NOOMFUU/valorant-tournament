# GEMINI.md

## Foundational Mandates
- **Language & Comments:** Use English for all new code and comments. Maintain existing Thai comments where they exist for context, but do not add new ones in Thai.
- **Module System:** Use CommonJS (`require`/`module.exports`) as per the existing codebase.
- **Architectural Patterns:**
  - Follow the established structure: `models/` for Mongoose schemas, `routes/` for API endpoints, `managers/` for complex business logic, `services/` for external integrations (Discord, Queue), and `middleware/` for request processing.
  - Use `req.app.get()` to access shared services (e.g., `io`, `discordClient`, `vetoMgr`) within routes.
  - Business logic related to brackets and vetoes should reside in their respective managers (`managers/bracketManager.js`, `managers/vetoManager.js`).
- **Error Handling:** Use `try/catch` blocks in async route handlers and return appropriate HTTP status codes (400 for bad requests, 401/403 for auth issues, 404 for not found, 500 for server errors).
- **Discord Integration:** All Discord-related logic should be routed through `services/discordService.js` or `services/discordBot.js`.
- **Real-time Updates:** Use Socket.IO for any features requiring real-time updates (vetoes, bracket updates, overlays). Access the `io` instance via `req.app.get('io')` or through `module.exports.getIO()` in `server.js`.
- **Database:** Use Mongoose for all MongoDB operations. Ensure models are properly populated when returning data to the frontend to minimize extra requests.

## Tech Stack
- **Backend:** Node.js, Express
- **Database:** MongoDB (Mongoose), Redis (for specific utils)
- **Real-time:** Socket.IO
- **External APIs:** Discord.js, Cloudinary (for images)
- **Frontend:** Plain HTML/CSS/JS (in `public/`)

## Development Workflow
- **Security:** Always use the `auth` middleware for protected routes. Use `express-rate-limit` for sensitive endpoints like login/register.
- **Validation:** Validate incoming request bodies using standard JS checks or consider adding a validation library if complexity increases.
- **Testing:** Currently, no tests are defined. When adding significant features, propose a testing strategy or add basic unit tests if appropriate.
