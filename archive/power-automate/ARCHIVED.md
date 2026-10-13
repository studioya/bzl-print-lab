# Archived: Microsoft 365 / Power Automate backend

Not in use. The site submits to the Google Apps Script backend (`apps-script/`).

This folder keeps the Power Automate version in case it's needed later (it requires the premium
"When an HTTP request is received" trigger):

- `README.md`: step-by-step guide for building the flow (OneDrive folders + Excel log + email).
- `BZL Print Lab Submissions.xlsx`: Excel log with a Dashboard sheet; `make-workbook.py` rebuilds it.
- `record.js` / `record.test.mjs`: builds the row and details.txt in the browser for the flow.

To bring it back, restore the Power Automate path in `js/submit.js` and `powerAutomateUrl` in
`js/config.js` from git history (commit "Microsoft 365 backend: Power Automate flow, OneDrive,
Excel log + dashboard").
