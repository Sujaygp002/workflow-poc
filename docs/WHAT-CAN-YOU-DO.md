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

And the people doing the activities each have their own door in:

- **Agency sign-in (HHAH portal)** — upload the paperwork (one spreadsheet of
  patients plus signed/unsigned order PDFs), see reminder notices, see their
  own patients and RCM Table.
- **Doctor-group sign-in (PG portal)** — see the orders waiting for a
  signature and **Bulk Sign** the whole batch at once.
- **Employee sign-in (EMPLOYEE portal)** — a to-do list in three columns
  (**Untouched / Processing / Done**): open a task, read the documents, type in
  the missing details, mark it complete.

## How it all fits together

An agency uploads its patients and orders. The persisted workflow wakes up and
runs its checklist on each one — system tasks fire on their own, and every
change lands in the object model where you can see it. When a step needs a
person, it appears in an employee's to-do list; orders needing a signature go
to the doctor for one bulk signing. Step by step the paperwork is built out
toward billing — and the whole journey is visible on the Orchestrator.
