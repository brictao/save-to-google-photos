# Save to Google Photos

A Chrome extension that lets you right-click any image on the web and save it directly to your Google Photos library.

## Features

- 🖱️ **Right-click to save** — Simple context menu integration
- 🔒 **Secure authentication** — Uses Google OAuth 2.0 via Chrome Identity API
- 🔔 **Two feedback channels** — In-page progress toast, plus a system notification when an upload fails in the background
- 🎨 **Premium UI** — Dark glassmorphism popup for auth management
- 📷 **Images and videos** — JPEG, PNG, WebP, HEIC and GIF; MP4 and MOV videos
- 🎞️ **Live Photo support** — Merges a page's photo and its paired video into one Google Motion Photo file, without re-encoding
- 🗂️ **Batch saving** — Saves every large image on the current page from the popup
- ♻️ **Duplicate guard** — Remembers what was already uploaded so a repeated click does not create a second copy
- 🧾 **Local history** — Keeps the last 100 results on this device, including failure reasons

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
5. Copy the **Client ID** and replace `YOUR_CLIENT_ID` in `extension/manifest.json`
6. Configure the **OAuth consent screen**:
   - Go to **APIs & Services** → **OAuth consent screen**
   - Add test users (your Google account email)
7. Reload the extension in `chrome://extensions`

## Usage

1. Click the extension icon → **Sign In** with your Google account
2. Right-click any image on a web page
3. Select **Save to Google Photos**
4. A notification will confirm the upload

### Pages that cover their images

Xiaohongshu and Instagram stack links, buttons and gradient overlays on top of every photo. Chrome then treats the click target as a plain page element, so the normal image menu item never appears. On these sites the extension registers a second entry, **Save image under cursor to Google Photos**, for any right-click. It records the cursor position, walks down through the overlaying elements, and picks the first `<img>`, `<video>` or CSS background image it finds. The site list lives in the `sgp_cover_sites` storage key and defaults to `*://*.xiaohongshu.com/*` and `*://*.instagram.com/*`; add patterns there to cover more sites.

On Xiaohongshu the rendered URL is usually a preview. The `sns-webpic-*` host serves a downscaled file, and the trailing `!nd_dft_wlteh_webp_3` style caps it again. The extension rewrites both parts to the `sns-img-*` host with the style stripped, and keeps the original preview URL as a fallback. Images on list and search pages top out around 640px wide because the page never receives a larger file, so open the note detail page to get the full-size version.

### Saving a video

Right-click a video and choose **Save to Google Photos**. Videos longer than 10 seconds are uploaded as the original file. Shorter clips are packaged as a Live Photo when the page exposes a matching still image, since Apple's own Live Photos are fixed at 3 seconds and third-party converters cap around 5. When the duration cannot be read, the cover-image rule decides.

### Choosing images and videos on a page

Open the popup and click **Choose images and videos**. A picker opens inside the page, showing up to 60 media cards with pixel dimensions and an **Image**, **Live Photo**, or **Video** label. Video cards also show their duration (or **Duration unknown**) and offer manual playback without autoplay. Clips with a cover and a duration of 10 seconds or less are saved as Live Photos; longer clips and clips without a cover are saved as videos. When duration is unknown, the existing cover-based rule applies. If manual preview discovers the duration, both the label and the save type update together. Unavailable video URLs, streaming playlists and known unsupported video extensions are shown with a reason and cannot be selected. A Live Photo whose motion clip is a blob URL stays selectable: the extension tries to read the clip from the page context and falls back to saving the cover image alone if that fails. A selectable Live Photo already includes its cover, so an identical cover image is not listed separately.

Image cards show a thumbnail with pixel dimensions underneath. Thumbnails keep each image's own aspect ratio, so a portrait shot is tall and a panorama is wide. Everything is selected by default; uncheck what you do not want, then click Save. For each image the extension prefers the largest `srcset` candidate, falls back to `data-*` lazy-load URLs, and strips CDN resize parameters (Qiniu `imageView2` / `imageMogr2`) while keeping the format segment, so the full-size file is uploaded instead of the grid thumbnail. Each entry keeps its original URL as a fallback when the cleaned one fails. The thumbnail itself loads the address the page already rendered, since guessed original-image hosts are often rejected by the CDN. It reuses that image element's own referrer policy, then retries the same URL without a Referer, and only then walks the download candidates in order. If every attempt fails, the card says the preview is unavailable and stays selectable, so the saved file is unaffected. Images smaller than 300×300 are skipped and repeated URLs are ignored. The extension remembers what it already saved so a repeated right-click does not create a duplicate.

The picker scans media already in the page DOM, including items outside the viewport; it does not scroll to load more content. When a matching in-page modal contains large images or video elements, collection is scoped to that container, including video-only modals. The current container matching does not check visibility. Image filtering still requires both dimensions to be at least 300px; videos do not use that size threshold. The 60-item limit applies to images and videos combined. Each selected Live Photo carries its own cover/video pair to the background, so batch saving does not depend on the last right-click target.

### Saving a Live Photo

Right-click the still image and choose **Save Live Photo to Google Photos**. The extension looks for the paired video in two ways:

1. A `<video>` element (or `data-video` style attribute) near the image
2. A same-named file next to the image, e.g. `IMG_4038.jpg` → `IMG_4038.MOV`

It then merges the JPEG still and the video into a single Google Motion Photo (`*.MP.jpg`) and uploads it. The video bytes are copied as-is, so the motion segment is not re-encoded.

**Requirements and limits:**

- The still image must be JPEG. Chrome cannot decode HEIC, so a HEIC cover is retried through the same URL with a JPEG format parameter before the extension reports that it cannot be used.
- The video must be an MP4/MOV container. If `moov` sits at the end of the file, it is relocated to the front so the motion segment is streamable.
- H.264 motion segments were verified end-to-end against the Google Photos API. HEVC segments are packaged the same way but have not been verified against Google Photos.
- The extension never modifies or uploads the page's original files; everything happens on the fetched bytes.

## Project Structure

```
save-to-google-photo/
├── extension/           # Load this folder in chrome://extensions
│   ├── manifest.json    # Extension configuration
│   ├── background.js    # Service worker (context menu + upload logic)
│   ├── content.js       # In-page toast + Live Photo video lookup
│   ├── motion-photo.js # Motion Photo 1.0 assembly (byte-level, no re-encode)
│   ├── popup.html       # Popup UI
│   ├── popup.js         # Popup auth logic
│   ├── popup.css        # Popup styling
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── release/             # Packaged zips (git-ignored)
├── livephoto-test/      # Local verification scripts and fixtures
├── store-assets/        # Chrome Web Store listing assets
├── PRIVACY_POLICY.md    # Privacy policy (required for Chrome Web Store)
├── PUBLISHING_GUIDE.md  # Release checklist
└── README.md            # This file
```

## Privacy

This extension does not collect, store, or share any personal data. Images are uploaded directly to your Google Photos account. A local history of the last 100 upload results and up to 500 duplicate-detection fingerprints stay in `chrome.storage.local` on this device and are never sent anywhere. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for full details.

## License

MIT License
