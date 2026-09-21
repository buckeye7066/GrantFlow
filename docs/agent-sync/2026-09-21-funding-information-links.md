# Funding information links

## Changed

The blind extractor now applies the existing explicit utility-label exclusion to information links as well as application links. Bill payment and email-update links selected by a model fall back to the fetched funding page. Valid application links remain intact. Extractor version 7 invalidates affected cached facts.

## Verified

A real funding-page extraction using only the local model completed in 40 seconds and selected the page's actual grant-application link. It also selected a bill-payment link as information, exposing this defect. Both utility-information regressions failed before the repair. Afterward, 29 focused tests and all 545 crawler tests passed. Independent review found no blocker.

## Unknown

This information-link repair requires deployment and live acceptance. One successful local extraction does not establish sustained capacity: production logs also show local timeouts/incomplete responses and exhausted hosted-provider quotas.
