# Privacy

AdLock does not collect or transmit telemetry.

It stores only these values in `chrome.storage.local` on the current browser profile:

- protection settings and site exceptions;
- user-authored domain and CSS rules;
- aggregate counts of page elements and redirect ads blocked, including capped per-domain counts.
- a bounded local reputation table containing target hostnames, scores, timestamps, and pseudonymous source-site hashes; it expires after 30 days and is capped at 500 hosts.

The extension reads page structure and relevant resource hostnames locally to classify likely advertisements. Full source-page URLs and page text are not added to the reputation table or sent to a server. A learned hostname is blocked only after corroboration from at least two unrelated source sites. Protected authentication, payment, and challenge providers are excluded.

Fingerprint defenses use an ephemeral per-page random seed. The seed and modified readback data are never stored. The extension does not create a stable cross-site identity.

Removing the extension deletes its extension storage. Statistics and learned hosts can be reset independently from Advanced settings; dynamic learning can also be disabled without deleting its existing local evidence.
