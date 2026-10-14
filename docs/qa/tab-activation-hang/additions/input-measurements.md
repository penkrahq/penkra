# Input delivery measurements

Primary event delay is page event epoch minus command-issued epoch. Command durations use monotonic time. Readback can wake a renderer; these tests measure immediate command delivery with observation, not unattended background timer cadence. Scroll state was checked separately from its event callback.

| Run / case                                     | Snapshot ms | Action | Command ms | Exact outcome  | Primary page event delay ms |
| ---------------------------------------------- | ----------: | ------ | ---------: | -------------- | --------------------------: |
| matrix/f-visible-throttle-true-bypass-false    |      52.814 | click  |    312.905 | success        |                         312 |
| matrix/f-visible-throttle-true-bypass-false    |      52.814 | type   |    311.639 | success        |                         311 |
| matrix/f-visible-throttle-true-bypass-false    |      52.814 | scroll |      1.853 | success        |                           9 |
| matrix/f-visible-throttle-true-bypass-false    |      52.814 | upload |     13.218 | success        |                          12 |
| matrix/f-visible-throttle-false-bypass-false   |       3.007 | click  |    297.651 | success        |                         296 |
| matrix/f-visible-throttle-false-bypass-false   |       3.007 | type   |    307.272 | success        |                         306 |
| matrix/f-visible-throttle-false-bypass-false   |       3.007 | scroll |      6.398 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-visible-throttle-false-bypass-false   |       3.007 | upload |      1.086 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-true-bypass-false     |       3.276 | click  |     21.712 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-true-bypass-false     |       3.276 | type   |      5.303 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-true-bypass-false     |       3.276 | scroll |      4.695 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-true-bypass-false     |       3.276 | upload |      7.225 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-true-bypass-true      |       3.712 | click  |      6.360 | success        |                           6 |
| matrix/f-hidden-throttle-true-bypass-true      |       3.712 | type   |    296.082 | success        |                         295 |
| matrix/f-hidden-throttle-true-bypass-true      |       3.712 | scroll |      3.931 | success        |                           6 |
| matrix/f-hidden-throttle-true-bypass-true      |       3.712 | upload |      3.195 | success        |                           3 |
| matrix/f-hidden-throttle-false-bypass-false    |       3.121 | click  |      1.301 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-false-bypass-false    |       3.121 | type   |      0.902 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-false-bypass-false    |       3.121 | scroll |      0.936 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-false-bypass-false    |       3.121 | upload |      1.521 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-hidden-throttle-false-bypass-true     |       3.170 | click  |      6.797 | success        |                           6 |
| matrix/f-hidden-throttle-false-bypass-true     |       3.170 | type   |  11975.995 | success        |                       11975 |
| matrix/f-hidden-throttle-false-bypass-true     |       3.170 | scroll |      1.096 | success        |                         983 |
| matrix/f-hidden-throttle-false-bypass-true     |       3.170 | upload |      3.115 | success        |                           2 |
| matrix/f-minimized-throttle-true-bypass-false  |       6.705 | click  |      2.552 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-true-bypass-false  |       6.705 | type   |      1.744 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-true-bypass-false  |       6.705 | scroll |      0.879 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-true-bypass-false  |       6.705 | upload |      0.824 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-true-bypass-true   |       3.494 | click  |      8.553 | success        |                           7 |
| matrix/f-minimized-throttle-true-bypass-true   |       3.494 | type   |    307.439 | success        |                         307 |
| matrix/f-minimized-throttle-true-bypass-true   |       3.494 | scroll |      1.812 | success        |                           8 |
| matrix/f-minimized-throttle-true-bypass-true   |       3.494 | upload |      3.638 | success        |                           3 |
| matrix/f-minimized-throttle-false-bypass-false |       3.005 | click  |      0.801 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-false-bypass-false |       3.005 | type   |      1.149 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-false-bypass-false |       3.005 | scroll |      0.821 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-false-bypass-false |       3.005 | upload |     56.133 | TAB_NOT_ACTIVE |                not observed |
| matrix/f-minimized-throttle-false-bypass-true  |       3.205 | click  |      6.699 | success        |                           6 |
| matrix/f-minimized-throttle-false-bypass-true  |       3.205 | type   |    296.247 | success        |                         296 |
| matrix/f-minimized-throttle-false-bypass-true  |       3.205 | scroll |      1.278 | success        |                           7 |
| matrix/f-minimized-throttle-false-bypass-true  |       3.205 | upload |      3.060 | success        |                           2 |
| repeat/f-hidden-throttle-true-bypass-true      |      50.810 | click  |     21.825 | success        |                          21 |
| repeat/f-hidden-throttle-true-bypass-true      |      50.810 | type   |  11541.220 | success        |                       11540 |
| repeat/f-hidden-throttle-true-bypass-true      |      50.810 | scroll |      1.975 | success        |                         989 |
| repeat/f-hidden-throttle-true-bypass-true      |      50.810 | upload |     11.311 | success        |                          10 |
| repeat/f-hidden-throttle-false-bypass-true     |       4.063 | click  |      7.228 | success        |                           6 |
| repeat/f-hidden-throttle-false-bypass-true     |       4.063 | type   |    306.373 | success        |                         305 |
| repeat/f-hidden-throttle-false-bypass-true     |       4.063 | scroll |      1.686 | success        |                           8 |
| repeat/f-hidden-throttle-false-bypass-true     |       4.063 | upload |      3.873 | success        |                           4 |

The JSON matrices retain immediate/1-second/3-second/pre-restore/post-restore state, full event sequences and trust flags, native window state, and backgroundThrottling getters. Successful bypass inputs arrived before shell restoration. Guarded failures were not followed by an input event in the bounded observation interval.
