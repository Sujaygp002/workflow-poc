# What can you do in the MVP?

The MVP is a control room for handling patient paperwork from home-health
agencies. Papers come in, the system walks each one through a checklist, and
people step in only when a human decision is needed. As it works, it builds the
**object model** — the patients, admissions, episodes and orders it keeps track
of — and saves every change in the **persistence layer** (the database), so
nothing is ever lost.

## 1. Build a process (the Workflow page)

This is where you use the **workflow language**: a checklist of steps you snap
together, which the system then follows in order.

- Click **New Workflow** to start building one from scratch.
- Add steps one by one. Some the computer does on its own; some are jobs for a
  person; some are yes/no questions that split the path two ways.
- For each people-step, pick **who** does it (which employee).
- Watch a live picture of your checklist grow as you add steps.
- **Save** it, then click **Run** to start it.
- On admin pages you can also add new employees, agencies, doctor groups, and
  their sign-in accounts — the people the workflow will use.

## 2. Watch it run (the Orchestrator page)

This is the live scoreboard for everything happening right now.

- See every run drawn as a **flowchart**, so you can follow the path each item took.
- See which step each item is sitting on at this moment.
- Spot which jobs are **waiting for a person** (a pink "to do" tag shows how many).
- See the **object model** grow: counts of patients, admissions, episodes and
  orders **created or updated**, shown as a family tree.
- Use the **time-travel control** to jump the clock forward a day and see what
  happens next — then reset it back.

## 3. See the big picture (the Coverage Map)

- A map showing every **agency** and every **doctor group** as circles.
- Click an agency to see which doctor groups it sends **patients** to, and how many.
- Click deeper to see doctors and the patients behind each connection.

## 4. Agency sign-in (the HHAH portal)

This is for an outside home-health agency.

- Sign in with a username and password.
- **Upload paperwork**: one spreadsheet of patients plus two folders of order PDFs
  (one for orders still needing a signature, one already signed).
- See **notices** reminding them when they still owe an upload.
- See a list of **their own patients** and the orders attached to each, and open an order to read its PDF.
- Check a billing table (the "RCM Table") for their patients.

## 5. Doctor-group sign-in (the PG portal)

This is for a doctor group. A "doctor" account can sign; an "admin" account only
sees the read-only tabs.

- Sign in with a username and password.
- See the orders that were **sent for signature** and are still waiting.
- Tick the ones to sign and use **Bulk Sign** to sign them all at once.
- Check a billing table (the "RCM Table") for the group.

## 6. Employee sign-in (the EMPLOYEE portal)

This is for a staff member doing the hands-on work.

- Sign in with a username and password.
- See their to-do list in three columns: **Untouched**, **Processing**, and **Done**.
- Open a task to start it — it moves into "Processing".
- **Read the documents and type in the missing details** the task asks for.
- Mark the task **complete** when finished, and it moves to "Done".

## How it all fits together

An agency uploads its patients and orders. The system runs the checklist — the
workflow — on each one, doing the easy steps by itself. Every step reads and
updates the **object model** (patient → admission → episode → order), and every
change lands safely in the **persistence layer**. When a step needs a person, it
shows up in an employee's to-do list. Orders that need a signature go to the
doctor, who signs a whole batch at once. Once everything is in order, the
paperwork is prepared for billing — and you can watch it all move along on the
Orchestrator page.
