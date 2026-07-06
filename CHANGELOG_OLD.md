# Older changes
## 1.2.2 (2025-10-18)
* added export/import to config tables

## 1.2.1 (2025-10-12)
* Bump @types/node to 24.7.2
* Bump @alcalzone/release-script-plugin-license to 4.0.0
* Bump rimraf to 6.0.1
* updated other dependencies
* fixed forbidden chars in ids

## 1.2.0 (2025-10-11)
* used iobroker prettier config
* changed title
* improved state roles and attributes
* limited send interval to 1 day
* fixed deletion of empty node channels
* removed old node string config

## 1.1.3 (2025-09-23)
* used @iobroker/eslint
* changed .vscode schema
* updated adapter-core dependency

## 1.1.2 (2025-09-23)
* fixed delete unused states

## 1.1.1 (2025-09-23)
* added logo
* upgrade to node 20
* updated dependencies

## 1.1.0 (2025-08-18)
* added units from https://fci.ta.co.at/docu/developer
* removed factors, decimals are computed automatically from the unit
* fixed problems with negative numbers

## 1.0.5 (2025-08-14)
* fixed layout

## 1.0.4 (2025-08-14)
* update dependencies

## 1.0.3 (2025-08-14)
* added factors to inputs/outputs settings
* update README

## 1.0.2 (2025-08-13)
* fixed degree, cubic meter symbol

## 1.0.1 (2025-08-13)
* fixed adapter crash on first start

## 1.0.0 (2025-08-13)
* improved config ui
* added support for units
* added support for names and descriptions for inputs/outputs
* BREAKING: state names now contain names from config

## 0.3.1 (2025-02-18)
* fix: negative values crashed adapter

## 0.3.0 (2025-02-17)
* added support for multiple messages in one packet (receiving and sending)
* added error handling

## 0.2.0 (2025-02-17)
* created bind and port options

## 0.1.2 (2025-02-17)
* downgrade to node 18
* create channel/devices before states
* performance improvements

## 0.1.1 (2025-02-16)
* improved log messages
* added log message if address/ip are already in use (probably two instances started)

## 0.1.0 (2025-02-16)
* (FreDeko) initial release
