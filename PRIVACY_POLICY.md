# Privacy Policy for Save to Google Photos Chrome Extension

**Last Updated: February 25, 2026**

## Overview

"Save to Google Photos" is a Chrome browser extension that allows users to save images from web pages directly to their Google Photos library via a right-click context menu.

## Data Collection and Usage

### What Data We Access

- **Google Account Authentication**: We use Google OAuth 2.0 (via the Chrome Identity API) to authenticate your Google account. This is required to upload images to your Google Photos library.
- **Image Data**: When you right-click an image and select "Save to Google Photos", the extension temporarily downloads the image data in order to upload it to your Google Photos account.

### What Data We Do NOT Collect

- We do **not** collect, store, or transmit any personal information.
- We do **not** track your browsing history or activity.
- We do **not** use analytics or tracking services.
- We do **not** store any image data locally or on any server — images are uploaded directly to your Google Photos account.
- We do **not** store your Google authentication tokens beyond the browser session cache managed by Chrome.

## Third-Party Services

This extension interacts with:

- **Google Photos API**: To upload images to your Google Photos library. Your use of Google Photos is subject to [Google's Privacy Policy](https://policies.google.com/privacy) and [Google Photos Terms of Service](https://policies.google.com/terms).
- **Chrome Identity API**: To handle Google OAuth 2.0 authentication. This is managed entirely by the Chrome browser.

## Permissions

The extension requests the following permissions:

| Permission | Purpose |
|---|---|
| `contextMenus` | Add "Save to Google Photos" to the right-click menu |
| `identity` | Authenticate with your Google account |
| `notifications` | Show upload status notifications |
| `activeTab` | Access the current tab to download image data |
| `host_permissions` | Communicate with Google Photos API and fetch images |

## Data Security

- All communication with Google APIs is conducted over HTTPS.
- Authentication tokens are managed by Chrome's built-in Identity API and are not accessible to third parties.
- No data is stored on external servers controlled by the developer.

## Changes to This Policy

We may update this Privacy Policy from time to time. Any changes will be reflected by updating the "Last Updated" date at the top of this document.

## Contact

If you have any questions about this Privacy Policy, please open an issue on our GitHub repository or contact us through the Chrome Web Store listing.
