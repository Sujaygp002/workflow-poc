# What can you do in the MVP?

The MVP is a control room for handling patient paperwork from home-health
agencies — and it proves out three things end to end:

1. You can **write a workflow in a simple workflow language, and it is persisted**
   — saved for good, versioned, and run on a schedule.
2. Every **change to the object model is visible** — you can watch patients,
   admissions, episodes and orders get created and updated as work happens.
3. All the **system tasks and human activities are happening live** — machine
   steps run on their own, people steps land on a real person's to-do list, and
   you can watch all of it move.

## 1. The workflow language — written once, persisted

On the **Workflow page** you build a process in the workflow language: a
checklist of steps snapped together in order.

- Add steps one by one: some the computer runs on its own, some are jobs for a
  person, some are yes/no questions that split the path two ways.
- For each people-step, pick **who** does it (which employee).
- When you **Save**, the workflow is **persisted to the persistence layer** —
  close the browser, come back tomorrow, it is still there. Every save keeps a
  **version**, and it fires automatically on its daily schedule.
- Admin pages let you add the employees, agencies, doctor groups and sign-in
  accounts the workflow will use — all persisted the same way.

## 2. The object model — every change visible

The object model is the family tree of the data: **Patient → Admission →
Episode → Order**. As the workflow runs, every create and update to it is
saved — and shown to you:

- The **Orchestrator** shows the object model as a tree next to each run, with
  live counts of what got **created** and **updated** at every level.
- The **Coverage Map** draws the bigger picture: agencies and doctor groups as
  circles, with the patients connecting them — click to drill down.
- The **agency and doctor-group portals** show the patient lists, the orders
  under each patient (with the PDF), and a billing view (the **RCM Table**).

## 3. System tasks and human activities — happening live

The **Orchestrator** is the live scoreboard:

- Every run is drawn as a **flowchart** — you can follow the exact path each
  item took and see which step it is sitting on right now.
- **System tasks** (checks, record writes, duplicate skips) run by themselves.
- **Human activities** show a pink "to do" tag; each one lands in a real
  person's list and the run waits there until it is done.
- A **time-travel control** jumps the clock a day forward so you can watch the
  next day's run happen — then reset it back.

And the people doing the activities each have their own door in — three
separate logins, each with its own screen.

### 3a. Agency login — the HHAH portal

This is where a home-health agency hands its paperwork in.

- **Sign in** with the username and password made for the agency.
- **Upload in one click:** the agency's files are already loaded in — a
  spreadsheet of patients plus two ZIPs of order PDFs (one unsigned, one
  signed) — so they just press **Start Upload**.
- See a **reminder notice** at the top when today's upload is owed and hasn't
  come in yet.
- Browse **their own patients**, and open a patient to see the orders listed
  under it.
- **Open an order** to read its PDF right on the page.
- See the **RCM Table** — the billing view for their patients.

### 3b. Internal users — the EMPLOYEE portal

This is where a staff member picks up the human steps of the workflow.

- **Sign in** with an employee username and password.
- Work from three to-do columns: **Untouched / Processing / Done**, with live
  counts.
- **Open a task** and it moves from Untouched to Processing.
- The task shows the **context** it needs — the patient and order details, and
  the order PDF — and asks for exactly what that step needs.
- **Type in the missing details** and **tick the checklist items** to confirm
  the work.
- **Complete the task** and it drops into Done — and the workflow moves on to
  its next step.

### 3c. Doctor-group login — the PG portal

This is where a physician group signs the orders that are waiting on them.

- **Sign in** with the doctor group's username and password.
- The portal knows if you are a **doctor** or an **admin** — a doctor signs
  with their own name and NPI; an admin sees the group's screens.
- See the **list of orders** that were sent for signature and are still
  waiting.
- **Tick** the orders you want (or tick all) and press **Bulk Sign** to sign
  the whole batch at once.
- See the **RCM Table** — the billing view for the whole group.

## How it all fits together

An agency uploads its patients and orders. The persisted workflow wakes up and
runs its checklist on each one — system tasks fire on their own, and every
change lands in the object model where you can see it. When a step needs a
person, it appears in an employee's to-do list; orders needing a signature go
to the doctor for one bulk signing. Step by step the paperwork is built out
toward billing — and the whole journey is visible on the Orchestrator.
