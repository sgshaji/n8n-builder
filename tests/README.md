# tests/

**Component tests written during the parallel build.** They tested one part at a time, before the parts were joined:

| Folder | Tests | Result during the build |
| --- | --- | --- |
| [`performer/`](performer/) | The RBIS adapter and the Performer, one case at a time (track A) | 96 of 96 passed |
| [`dispatcher/`](dispatcher/) | The Dispatcher, with a stand-in Performer (track B) | 158 of 158 checks passed |

**These scripts cannot run as they are.** They used private build resources that were removed once the parts were joined: separate tables, a private pretend RBIS on port 8089, a test harness workflow, a stand-in Performer and a separate Settings copy. The build notes say how each was set up: [track A](../docs/build-notes/track-A.md), [track B](../docs/build-notes/track-B.md). They are kept as a record of what was tested, and as a starting point if a component needs testing on its own again.

**The maintained tests are elsewhere:**

- **All 37 scenarios, end to end**, against the real workflows: `node scripts/run-tests.mjs`. See [Testing HARSLL](../docs/testing.md).
- **Unit tests** for the test kit and the pretend RBIS: `node --test scripts/ mock-rbis/`.
