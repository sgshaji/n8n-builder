# Build history

**For:** anyone who wants to know how HARSLL was built and why some choices were made. Nothing here is needed to run, change or move HARSLL; the current documents are listed in [docs/README.md](../README.md).

| Document | What it records |
| --- | --- |
| [Phase 4 trials: results](phase-4-trials.md) | Four short trials run before building, and what each proved about n8n |
| [Track A build notes](build-notes/track-A.md) | The RBIS adapter and the Performer: how they were built and tested, and where they departed from the design |
| [Track B build notes](build-notes/track-B.md) | The Dispatcher, before it was split into three workflows |
| [Track C build notes](build-notes/track-C.md) | The test kit: scenarios, spreadsheet generator and test runner |

Names and IDs in these notes are as they were at the time. Since then the RBIS adapter was renamed **HARSLL – Performer: RBIS adapter**, and the Dispatcher's file intake and batch reporting became their own workflows (design changes B17 and B18).

## How the build was organised

Three tracks built in parallel on one local n8n, each with its own copies of the shared resources, then a reconcile stage joined them, ran all 37 scenarios and removed the copies.

| Track | Built | Its own resources (all removed) |
| --- | --- | --- |
| **A** | RBIS adapter and Performer | Table `trackA_cases`; a pretend RBIS copy `mock-rbis-a` on port 8089; a test harness workflow |
| **B** | Dispatcher | Tables `trackB_cases`, `trackB_batches`, `trackB_lock`; a Settings copy; a stand-in Performer; folders `data/trackB/` |
| **C** | Test kit | Tables `trackC_cases`, `trackC_batches`, `trackC_lock`; a pretend RBIS copy `mock-rbis-c` on port 8091; folders `data/trackC/` |

Rules the tracks worked to: touch only your own resources; prefix test webhooks with the track name; never commit (the reconcile stage did); write build notes.

## Removed component tests

Tracks A and B each wrote component tests (`tests/performer/`, 96 tests, and `tests/dispatcher/`, 158 checks), which all passed during the build. They needed the track resources above, so they could not run once those were removed, and were deleted from the repository. They remain in the Git history: commit `563c507` and earlier. The maintained tests are the 37 end-to-end scenarios: [Testing HARSLL](../testing.md).
