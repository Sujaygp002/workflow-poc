# sample-4-artifacts

A broad wf7 test set: **18 patient rows + 22 order rows (23 joined rows)** exercising
the major branches, plus the two-ZIP signed/unsigned model.

## Files

- `hhh_upload_set4.xlsx` — Sheet1 = patients, Sheet2 = orders.
- `hhh_order_pdfs_unsigned_set4.zip` — 14 unsigned order PDFs (to be sent for signing).
- `hhh_order_pdfs_signed_set4.zip` — 6 already-signed order PDFs.
- Order **O-1009 has no PDF in either ZIP** (tests the no-matched-PDF branch).

Upload the Excel as the workbook, the unsigned ZIP as **Unsigned order PDFs**, and the
signed ZIP as **Signed order PDFs**. Scope defaults to Boise-Ada Metro Intake / Boise Home Health.

## Test scenarios (by order/patient)

| # | Order | Patient | What it exercises |
|---|-------|---------|-------------------|
| 1 | O-1001 | Aaron Blake | Happy path, **signed** PDF → treated as already signed (no overdue email) |
| 2 | O-1002 | Bella Cruz | Happy path, **unsigned** PDF → send-to-physician path |
| 3 | O-1003 | Cody Drew | **Missing SOC** → Manually Add Admission Dates branch |
| 4 | O-1004 | Dana Ellis | **Missing SOE/EOE** → Manually Add Episode Dates branch |
| 5 | O-1005 (×2) | Evan Frost | **Duplicate order number** → Skip Duplicate Order |
| 6 | O-1006 | Grace Hill (PG_A) | Same Unit, PG_A record |
| 7 | O-1007 | Grace Hill (PG_B) | **PG change → new Patient Record** under same Unit; signed PDF |
| 8 | O-1008 | Ivan Jones | **New patient** → create Unit + Record; signed PDF |
| 9 | O-1009 | Kara Lane | **No matched PDF** → order fields/PDF missing → human fix |
| 10 | O-1010, O-1011 | Liam Moss | **Multiple orders** for one patient (PoC + Recert) |
| 11 | O-1012 | Mia Nolan | **Missing MRN** on patient + order |
| 12 | O-1013 | Owen Pratt | **Missing NPI** + **six diagnosis codes** |
| 13 | O-1014 | Paula Quinn | Signed PDF |
| 14 | O-1015 | Uma Wells | **Order-only row** (no Sheet1 patient — resolved from order FK) |
| 15 | (none) | Rita Stone | **Patient-only row** (no order) |
| 16 | O-1017 | Sam Tully | **Missing sex + address** |
| 17 | O-1018 | Tina Vale | **Different HHAH** (Treasure Valley Hospice); signed PDF |
| 18 | O-1019 | Aaron Blake | **Future-dated** Recert order for an existing patient |
| 19 | O-1020 | Bella Cruz | Order **SOC/SOE override** patient sheet dates |
| 20 | O-1021 | John Smith (MRN-1021) | **Same name, different MRN/DOB** → distinct Unit; signed PDF |
| 21 | O-1022 | John Smith (MRN-1022) | Same name, second distinct Unit |

Signed PDFs: O-1001, O-1007, O-1008, O-1014, O-1018, O-1021.
Unsigned PDFs: O-1002, O-1003, O-1004, O-1005, O-1006, O-1010, O-1011, O-1012, O-1013,
O-1015, O-1017, O-1019, O-1020, O-1022.
