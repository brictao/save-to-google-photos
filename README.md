# Save to Google Photos

A Chrome extension that lets you right-click any image on the web and save it directly to your Google Photos library.

## Features

- 🖱️ **Right-click to save** — Simple context menu integration
- 🔒 **Secure authentication** — Uses Google OAuth 2.0 via Chrome Identity API
- 🔔 **Notifications** — Get instant feedback on upload status
- 🎨 **Premium UI** — Dark glassmorphism popup for auth management
- 📷 **Wide format support** — JPEG, PNG, GIF, WebP, and more
- 🎞️ **Live Photo support** — Merges a page's photo and its paired video into one Google Motion Photo file, without re-encoding

## Installation

### From Chrome Web Store

1. Visit the [Chrome Web Store listing](#) *(link coming soon)*
2. Click **Add to Chrome**
3. Click the extension icon and sign in with your Google account

### For Development

1. Clone this repository
2. Go to `chrome://extensions` in Chrome
3. Enable **Developer Mode** (top right)
4. Click **Load unpacked** and select this folder
5. Set up Google Cloud OAuth (see below)

## Google Cloud Setup (Development Only)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Enable the **Photos Library API**:
   - Navigate to **APIs & Services** → **Library**
   - Search for "Photos Library API" and enable it
4. Create OAuth 2.0 credentials:
   - Go to **APIs & Services** → **Credentials**
   - Click **Create Credentials** → **OAuth client ID**
   - Application type: **Chrome Extension**
   - Enter your Extension ID (found in `chrome://extensions`)
5. Copy the **Client ID** and replace `YOUR_CLIENT_ID` in `manifest.json`
6. Configure the **OAuth consent screen**:
   - Go to **APIs & Services** → **OAuth consent screen**
   - Add test users (your Google account email)
7. Reload the extension in `chrome://extensions`

## Usage

1. Click the extension icon → **Sign In** with your Google account
2. Right-click any image on a web page
3. Select **Save to Google Photos**
4. A notification will confirm the upload

### Saving a Live Photo

Right-click the still image and choose **Save Live Photo to Google Photos**. The extension looks for the paired video in two ways:

1. A `<video>` element (or `data-video` style attribute) near the image
2. A same-named file next to the image, e.g. `IMG_4038.jpg` → `IMG_4038.MOV`

It then merges the JPEG still and the video into a single Google Motion Photo (`*.MP.jpg`) and uploads it. The video bytes are copied as-is, so the motion segment is not re-encoded.

**Requirements and limits:**

- The still image must be JPEG. HEIC stills cannot be decoded by Chrome, so those pages usually need to be reached through a client that already converts them.
- The video must be an MP4/MOV container. If `moov` sits at the end of the file, it is relocated to the front so the motion segment is streamable.
- H.264 motion segments were verified end-to-end against the Google Photos API. HEVC segments are packaged the same way but have not been verified against Google Photos.
- The extension never modifies or uploads the page's original files; everything happens on the fetched bytes.

## Project Structure

```
save-to-google-photo/
├── manifest.json        # Extension configuration
├── background.js        # Service worker (context menu + upload logic)
├── content.js           # In-page toast + Live Photo video lookup
├── motion-photo.js      # Motion Photo 1.0 assembly (byte-level, no re-encode)
├── popup.html           # Popup UI
├── popup.js             # Popup auth logic
├── popup.css            # Popup styling
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── PRIVACY_POLICY.md    # Privacy policy (required for Chrome Web Store)
└── README.md            # This file
```

## Privacy

This extension does not collect, store, or share any personal data. Images are uploaded directly to your Google Photos account. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for full details.

## License

MIT License
