# Google Drive Sync for Obsidian (custom plugin)

This plugin syncs your vault both ways with a folder in your own Google Drive. It works on Windows, Mac, Linux, Android and iPhone, and it's free: it uses your Google account's free 15 GB.

## What it does
- It syncs notes and attachments. It does not sync the `.obsidian` settings folder.
- It syncs new files, edits and deletions. Deleted files go to the trash on the other side, so you can get them back.
- If the same note was edited on both devices, it keeps your version and saves the other one as `note (conflict 2026-11-14 1830).md`, so nothing is lost.
- It syncs on startup, every N minutes, and whenever you press the 🔄 ribbon icon or run the command "Google Drive Sync: Sync now".
- It only gets access to files it created itself (Google's `drive.file` permission), so it can't read the rest of your Drive.

---

## Step 1: Create your own Google "app" (one time, about 5 minutes, free)
1. Go to https://console.cloud.google.com and create a new project, for example "Obsidian Sync".
2. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Go to **Google Auth Platform** (also shown as **OAuth consent screen**) and click **Get started**:
   - App name: anything. Support email: yours. Audience: **External**. Contact email: yours. Then create it.
4. Under **Audience**, click **Publish app** and confirm.
   ⚠️ Don't skip this. If the app stays in "Testing" mode, Google logs you out every 7 days. The plugin only uses the basic `drive.file` permission, so publishing doesn't need a Google review.
5. Under **Clients**, click **Create client**:
   - Application type: **TVs and Limited Input devices** (this type is required).
   - Copy the **Client ID** and **Client secret**.

## Step 2: Install on your laptop
1. Close Obsidian.
2. Copy the `gdrive-sync` folder (it has `manifest.json` and `main.js`) into:
   `YourVault/.obsidian/plugins/gdrive-sync/`
   (`.obsidian` is a hidden folder. Turn on "show hidden files" if you can't see it.)
3. Open Obsidian and go to **Settings → Community plugins**. Turn off Restricted mode and enable **Google Drive Sync**.
4. Open the plugin's settings and paste in the Client ID and Client secret.
5. Click **Connect**. A code appears. Open google.com/device on any device, enter the code, choose your account, and click **Allow**.
   - If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. That's your own app, so it's safe.
6. Click **Sync now**. The first sync uploads your whole vault.

## Step 3: Install on your phone
1. In the Obsidian app, create a new empty vault with **the same name** as on your laptop. (Or leave the name as it is and set the same "Drive folder name" in the plugin settings on both devices.)
2. Put the plugin into that vault's `.obsidian/plugins/gdrive-sync/` folder:
   - **Android:** Copy the folder over by USB or Drive, then use a file manager that shows hidden files (for example "Files by Google" or Solid Explorer) to move it into `YourVault/.obsidian/plugins/`.
   - **iPhone:** The Files app hides `.obsidian`. The easiest way is to put `main.js` and `manifest.json` in a GitHub release and install it with the **BRAT** community plugin.
3. Enable the plugin and paste in the **same** Client ID and Client secret. Click **Connect**, approve, then click **Sync now**. Your notes will download.

## Tips
- Sync the laptop first, then the phone.
- Don't run another sync tool (Obsidian Sync, Syncthing, iCloud) on the same vault at the same time.
- Use **Excluded paths** for big folders you don't need on your phone.
- If something fails, open the developer console with Ctrl+Shift+I on desktop and look for lines starting with `[gdrive-sync]`.
- In Google Drive, your vault shows up as one folder (e.g. "Obsidian - MyVault"). The files inside are stored by their full path, like `Projects/idea.md`.
