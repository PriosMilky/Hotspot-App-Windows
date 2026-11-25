# CO&CO MikroTik Hotspot App (Windows)

This folder is a standalone copy of the files needed to run the local app. It does not contain router passwords, `node_modules`, Next.js build files, or development-only files.

## Requirements

- Windows 11
- Node.js LTS 20 or newer (Node.js 22 LTS recommended)
- A local network connection to the MikroTik router
- Internet for the first dependency installation only

## First run

1. Copy the entire `Hotspot-App-Windows` folder to a writable location, such as `Documents`. Do not put it under `Program Files`.
2. Install Node.js LTS from [nodejs.org](https://nodejs.org/).
3. Double-click `setup-windows.bat`. It creates a local `.env`, installs dependencies, and prompts you to create the first web-app account. The password is not echoed and only its bcrypt hash is stored.
4. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) and sign in with that account.
5. Open **Connection Settings**, enter the router address, HTTPS port, API username, and API password, then choose **Save & Test Connection**.

The web-app login is separate from MikroTik Hotspot users. There is no public registration; an administrator can add up to five accounts by running `npm run setup-auth` in this folder. Login sessions expire after eight hours. Keep `.env` private.

## Later runs

Double-click `start-windows.bat`. Keep its terminal window open while using the app. Press `Ctrl+C` in that window to stop the app.

## Internal HTTPS certificate

If MikroTik uses a private CA, copy its public CA certificate into this folder as `router-ca.crt`. The Windows scripts will configure Node.js to trust it. Never copy a certificate private key.

## Network and security

The app listens on `127.0.0.1:3000` by default, so it is available only on this PC. The PC must still be connected to the router's LAN even when the internet is offline. Do not expose the app or the router's REST API to the public internet.

The router password is saved only in the local `.env`. Do not share that file. Reconfigure the connection on each PC instead of copying `.env`.

The dashboard counts Hotspot sessions using at least 10 kbps of combined upload and download, sampled every 10 seconds. It shows the three sessions with the highest combined traffic since login and refreshes that list every five minutes; device names come from DHCP lease hostnames or fall back to the MAC address. Combined upload and download speed is averaged from traffic-counter changes over 60 seconds and updated once per minute. The first count and speed readings appear after their initial measurement periods.

## Changing the logo

Click **Add logo** beside the current logo and choose a PNG, JPG, or WebP image up to 2 MB. The new image appears in the header and printed voucher and is saved in this browser on this PC only; it is not uploaded to the server or MikroTik. Choose another image to replace it, or click **Restore default** to return to the CO&CO logo.

Use the **Dark mode** button in the header to switch themes. The selected theme is saved in this browser; choose **Light mode** to switch back.
