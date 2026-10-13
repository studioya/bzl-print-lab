# Submissions with Microsoft 365 (Power Automate + OneDrive + Excel)

When a student submits, the page sends everything to one Power Automate flow. The flow:

- saves the model files and the Bambu project (`plates.3mf`) in a folder per submission in OneDrive:
  `STUDENT 3D SUBMISSIONS/Main/…` or `STUDENT 3D SUBMISSIONS/Architecture/…`, depending on the
  center the student chose. Folder names start with the date, so sorting by name (Z→A) lists the
  newest first;
- writes `details.txt` with all the submission details into that folder;
- adds a row to the Excel log `STUDENT 3D SUBMISSIONS/BZL Print Lab Submissions.xlsx` (sheet
  **Submissions**). The **Status** column has a dropdown for the lab, and a **Center** column says
  which center it was sent to;
- emails the student a confirmation.

The workbook's **Dashboard** sheet summarises the log and updates by itself: open/waiting/overdue
counts, hours of print work in the queue, totals per status and center, submissions per month, and
two charts.

Build it once, signed in to the Microsoft 365 account that should own the files. It takes about
30–45 minutes. You need Power Automate with the premium **When an HTTP request is received** trigger.

> How the page talks to the flow: each file is sent as its own request (raw file bytes, details in
> the URL), then one final `submit` request with the record. The flow only accepts `.stl`, `.obj` and
> `.3mf` files, only inside `STUDENT 3D SUBMISSIONS/Main` or `/Architecture`, and never a path with
> `/`, `\` or `..` in it.

---

## 1. Put the Excel log in OneDrive

1. In OneDrive, create a folder **`STUDENT 3D SUBMISSIONS`** (in the top level of your OneDrive).
2. Upload [`BZL Print Lab Submissions.xlsx`](BZL%20Print%20Lab%20Submissions.xlsx) from this folder into it.
   Don't rename the file, the sheet **Submissions**, the table (also called **Submissions**) or the
   column headings: the flow and the dashboard use those names.

## 2. Create the flow

In [Power Automate](https://make.powerautomate.com): **Create → Instant cloud flow → Skip**, and name it
`BZL Print Lab submissions`.

Wherever a step below says **expression**, don't type or paste it straight into the field (it would
be saved as plain text). Instead:

1. Click into the field. Two small buttons appear at its right end: a lightning bolt
   (*dynamic content*) and **fx** (*expression*). You can also type `/` in the field and choose
   **Insert expression**.
2. Click **fx**. A panel opens with a box at the top.
3. Paste the expression into that box (without any `=` or `@` in front) and click **Add**.
4. The field now shows a coloured token with the start of the expression, e.g. `concat(...)`.
   Click the token to see or edit it. If the expression has a typo, the panel shows an error instead
   of adding it.

Rename steps with **⋯ → Rename**. The names matter, because later expressions refer to them: use
exactly the names given here (**BaseFolder**, **Submission**), with no spaces.

### Trigger: When an HTTP request is received

- **Who can trigger the flow:** Anyone
- **Request Body JSON Schema:** leave empty
- Under **Advanced parameters → Method:** POST

### Step 1: Compose, renamed **BaseFolder**

**Inputs** (expression):

```
concat('/STUDENT 3D SUBMISSIONS/', if(equals(triggerOutputs()?['queries']?['center'], 'architecture'), 'Architecture', 'Main'), '/', triggerOutputs()?['queries']?['folder'])
```

### Step 2: Condition, renamed **Request is safe**

Set the row to: (expression below) **is equal to** `true` (type `true` as an expression too).

```
and(not(empty(triggerOutputs()?['queries']?['folder'])), not(contains(triggerOutputs()?['queries']?['folder'], '/')), not(contains(triggerOutputs()?['queries']?['folder'], '\')), not(contains(triggerOutputs()?['queries']?['folder'], '..')), not(contains(coalesce(triggerOutputs()?['queries']?['name'], ''), '/')), not(contains(coalesce(triggerOutputs()?['queries']?['name'], ''), '\')), not(contains(coalesce(triggerOutputs()?['queries']?['name'], ''), '..')))
```

**If no:** add a **Response** step (see [Responses](#responses)) with status `400` and body
`{"ok": false, "error": "Request not allowed."}`.

**If yes:** add a **Switch** (step 3).

### Step 3: Switch on the action

**On** (expression): `triggerOutputs()?['queries']?['action']`

#### Case 1: equals `file`

1. **Condition**, renamed **Model file**: (expression) **is equal to** `true`:

   ```
   or(endsWith(toLower(triggerOutputs()?['queries']?['name']), '.stl'), endsWith(toLower(triggerOutputs()?['queries']?['name']), '.obj'), endsWith(toLower(triggerOutputs()?['queries']?['name']), '.3mf'))
   ```

   - **If yes:**
     1. **OneDrive for Business → Create file**
        - **Folder Path** (expression): `outputs('BaseFolder')`
        - **File Name** (expression): `triggerOutputs()?['queries']?['name']`
        - **File Content** (expression): `triggerBody()`
     2. **Response**: status `200`, body `{"ok": true}`
   - **If no:** **Response**: status `400`, body `{"ok": false, "error": "File type not allowed."}`

#### Case 2: equals `submit`

1. **Compose**, renamed **Submission**. **Inputs** (expression):

   ```
   json(base64ToString(coalesce(triggerBody()?['$content'], base64(string(triggerBody())))))
   ```

2. **OneDrive for Business → Create file**
   - **Folder Path** (expression): `outputs('BaseFolder')`
   - **File Name** (expression): `concat(outputs('Submission')?['row']?['id'], ' – details.txt')`
   - **File Content** (expression): `outputs('Submission')?['detailsText']`

3. **Excel Online (Business) → Add a row into a table**
   - **Location:** OneDrive for Business · **Document Library:** OneDrive
   - **File:** browse to `/STUDENT 3D SUBMISSIONS/BZL Print Lab Submissions.xlsx`
   - **Table:** Submissions
   - The columns then appear as fields. Fill them in as follows: type **Status** as plain text,
     leave **Lab notes** empty, and give every other column the expression
     `outputs('Submission')?['row']?['KEY']` with the key from this table:

     | Column | KEY | | Column | KEY |
     |---|---|---|---|---|
     | Submitted | `submitted` | | Pieces | `pieces` |
     | Submission ID | `id` | | Color | `color` |
     | Status | *type* `New` | | Profile | `profile` |
     | Center | `center` | | Est. time (min) | `estMinutes` |
     | Name | `name` | | Est. cost (ILS) | `estCost` |
     | ID number | `idNumber` | | Plates | `plates` |
     | Email | `email` | | Filament (g) | `grams` |
     | Phone | `phone` | | Objects | `objects` |
     | Department | `department` | | Supports | `supports` |
     | Course | `course` | | Files | `files` |
     | Deadline | `deadline` | | Folder | `folder` |
     | Student notes | `notes` | | Lab notes | *leave empty* |

     For example, **Name** = `outputs('Submission')?['row']?['name']`.

4. **Office 365 Outlook → Send an email (V2)**
   - **To** (expression): `outputs('Submission')?['row']?['email']`
   - **Subject** (expression):
     ```
     concat('BZL Print Lab – submission ', outputs('Submission')?['row']?['id'], ' received · ההגשה התקבלה')
     ```
   - **Body** (expression). Every value from the form is escaped, so nobody can put links or
     HTML into an email sent from the lab's account:
     ```
     concat('<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2327;max-width:560px"><p>Hi ', replace(replace(string(outputs('Submission')?['row']?['name']), '<', '&lt;'), '>', '&gt;'), ',</p><p>We received your 3D print submission. Prints can take up to several weeks, depending on the lab''s queue. The time and cost below are estimates; the lab will confirm the final details.</p><div dir="rtl" style="text-align:right"><p>שלום ', replace(replace(string(outputs('Submission')?['row']?['name']), '<', '&lt;'), '>', '&gt;'), ',</p><p>קיבלנו את הגשת ההדפסה שלך. הדפסות עשויות להימשך עד מספר שבועות, בהתאם לתור במעבדה. הזמן והעלות שלהלן הם הערכה בלבד; המעבדה תאשר את הפרטים הסופיים.</p></div><table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 10px 4px 0;color:#555">Submission number · מספר הגשה</td><td><b>', string(outputs('Submission')?['row']?['id']), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Sent to · נשלח אל</td><td><b>', replace(replace(string(outputs('Submission')?['row']?['center']), '<', '&lt;'), '>', '&gt;'), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Profile · פרופיל</td><td><b>', replace(replace(string(outputs('Submission')?['row']?['profile']), '<', '&lt;'), '>', '&gt;'), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Color · צבע</td><td><b>', replace(replace(string(outputs('Submission')?['row']?['color']), '<', '&lt;'), '>', '&gt;'), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Pieces · חלקים</td><td><b>', string(outputs('Submission')?['row']?['pieces']), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Needed by · תאריך יעד</td><td><b>', replace(replace(string(outputs('Submission')?['row']?['deadline']), '<', '&lt;'), '>', '&gt;'), '</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Estimated print time · זמן הדפסה משוער</td><td><b>', string(outputs('Submission')?['row']?['estMinutes']), ' min</b></td></tr><tr><td style="padding:4px 10px 4px 0;color:#555">Estimated cost · עלות משוערת</td><td><b>₪', string(outputs('Submission')?['row']?['estCost']), '</b></td></tr></table><p style="color:#777;font-size:12px">BZL Print Lab</p></div>')
     ```
   - Optional: to also notify the lab, add a second **Send an email (V2)** to the lab's address with,
     for example, the subject `concat('New print submission ', outputs('Submission')?['row']?['id'], ' – ', outputs('Submission')?['row']?['center'])`.

5. **Response**: status `200`, body `{"ok": true}`

#### Default case

**Response**: status `400`, body `{"ok": false, "error": "Unknown request."}`

### Responses

Every **Response** step needs two headers, so the browser accepts the answer:

| Key | Value |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Content-Type` | `application/json` |

## 3. Connect the page

1. **Save** the flow. Open the trigger again and copy the **HTTP URL** it now shows. It's long,
   and its `sig=` part is what lets the page call the flow.
2. Put it in [`js/config.js`](../js/config.js) as `powerAutomateUrl`, or send it to whoever
   maintains the page. When `powerAutomateUrl` is set the page uses this flow; the Google Apps
   Script backend (`appsScriptUrl`) is then not used.
3. Make a test submission with your own email and check that:
   - a folder appeared in `STUDENT 3D SUBMISSIONS/Main` (or `/Architecture`) with the files and
     `details.txt`,
   - a row was added to the Excel table, with Status **New**, and the Dashboard counts it,
   - the confirmation email arrived.

   If something fails, open the flow's **Run history**: the failed step shows the reason.

## Using the log and the dashboard

- Change a submission's **Status** with the dropdown in the Status column. Use **Lab notes** for
  anything else. Don't change the other columns' headings.
- New rows are added at the bottom of the table. To see the newest first, sort the **Submitted**
  column Z→A (Excel's filter button on the heading).
- If the first row of the table is empty (from the empty template), delete it after the first real
  submission arrives.
- The **Dashboard** sheet recalculates whenever the file is opened or changed. Its center names (cells
  J14:J15) must match the names the page writes, which are in `centers` in `js/config.js`.
- To rebuild the empty workbook (for example after adding a column): `pip install openpyxl`, then
  `python3 tools/make-workbook.py`. Add the new column to the flow's **Add a row** step too.

## Limits and privacy

- **File size:** the page allows up to 25 MB per file, and the flow trigger accepts up to 100 MB per
  request. Very large files take longer to upload.
- **The flow URL** is in the public page, like any form's address. The flow only writes into the
  two submission folders and only accepts model files. To stop all submissions, turn the flow off.
- **Personal data** (names, ID numbers, phones, emails) stays in your Microsoft 365 OneDrive.
  Keep the folder and workbook shared only with lab staff.
