# Cloudflare public link

The simplest development option is a Cloudflare Quick Tunnel. It gives you a temporary HTTPS URL and does not require opening your router ports.

## 1. Install cloudflared

Install `cloudflared` from Cloudflare's official documentation, then confirm:

```powershell
cloudflared --version
```

## 2. Start the EMS backend

Terminal 1:

```powershell
cd "C:\Users\YOGA\OneDrive\Desktop\Lalitpur-EMS-Test\backend-files\backend"
npm run dev
```

Keep it running on port 4000.

## 3. Start the Vite frontend

Terminal 2:

```powershell
cd "C:\Users\YOGA\OneDrive\Desktop\Lalitpur-EMS-Test"
npm run dev -- --host 0.0.0.0
```

Keep the frontend on the port Vite reports (normally 5173).

## 4. Create the public Cloudflare link

Terminal 3:

```powershell
cloudflared tunnel --url http://localhost:5173
```

Cloudflare will print a URL similar to:

```text
https://something-random.trycloudflare.com
```

Open that HTTPS URL. Because the frontend proxies `/api` to localhost:4000, the API is served through the same public origin.

### QR links

For local testing, the backend `.env` has:

```text
PUBLIC_APP_URL=http://localhost:5173
```

If you want QR codes generated for the Cloudflare URL, change it to the exact URL Cloudflare gives you, for example:

```text
PUBLIC_APP_URL=https://something-random.trycloudflare.com
```

Then restart the backend.

A Quick Tunnel URL changes when you restart the tunnel. For a permanent link, use a named Cloudflare Tunnel attached to a domain you control.

## Production recommendation

Do not expose the development Vite server as the permanent production application. Build the frontend with:

```powershell
npm run build
```

and serve the generated `dist` directory behind a proper production web server or Cloudflare Pages/Workers. Keep the Node API behind HTTPS and use a real domain.
