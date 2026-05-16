# Privacy Policy

Effective date: May 16, 2026

标签页自动恢复 is a browser extension that saves and restores the user's most recent valid tab session.

## Data Collected

The extension may store the following data locally in the user's browser:

- Tab URLs
- Tab titles
- Tab order

This data is used only to restore the user's previous tab session.

## Local Storage Only

All saved tab session data stays on the user's device through the browser's local extension storage.

The extension does not:

- Send data to any developer server
- Send data to any third-party service
- Use analytics or tracking tools
- Sell, rent, or share user data
- Use user data for advertising
- Use user data for credit, lending, or eligibility decisions

## Remote Code

The extension does not use remote code. All JavaScript code is included inside the extension package.

The extension does not load external scripts, dynamically download executable code, or use `eval` or similar dynamic code execution.

## Data Retention

The extension keeps only the most recent valid tab session needed for restoration.

Users can delete stored data at any time by removing the extension or clearing the extension's site/app data from the browser.

## Permissions

The extension requests only the permissions needed for its single purpose:

- `tabs`: to read currently open tab URLs and titles, and to recreate tabs during restore
- `windows`: to detect browser window creation and closing
- `storage`: to save the latest tab session locally

## Contact

For questions about this privacy policy, please contact the project maintainer through the GitHub repository:

https://github.com/KouriVar/tab-auto-restore
