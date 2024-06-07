# Key Usage Indicators data collection script

Key Usage Indicators (KUI) dashboard, an example available at
[gxy.io/kui](https://gxy.io/kui), is a high-level dashboard summarizing usage
information about Galaxy server(s). The dashboard presents up-to-date
information about user registrations, service usage, and user jobs. Script
`kui.sh` is used to collect data from Galaxy servers and store it in the
BigQuery database, from where the dashboard is populated.

The dashboard focuses on displaying month-level data so the script is designed
to be run every month.

## Setup

### Local environment setup

To run this script, you need
[google-cloud-sdk](https://cloud.google.com/sdk/docs/install) installed and
configured, including being logged in. You also need
[`gxadmin`](https://github.com/galaxyproject/gxadmin) installed and configured.

### BigQuery setup

The KUI dashboard relies on a BigQuery (BQ) database to retrieve the data, which
the `kui.sh` script populates with data from Galaxy. To set up BQ, you need to
create a BQ `dataset` and three tables: `users`, `jobs`, and `usage`. The schema
for each of the tables is available in the `json` files in this repository. You
can use those to create the tables in your BQ dataset.

### Configuration

Before running the script, you need to set up the following variables at the top
of the script: `PROJECT_ID`, `DATASET`, `USERS_TABLE`, `JOBS_TABLE`, and
`USAGE_TABLE`. These are all BigQuery information fields we set up above.

You may also need to set the following environment variable for gxadmin:
`export PGDATABASE=galaxy_database_name`.

### Dashboard

The KUI dashboard is built using [Looker
Studio](https://lookerstudio.google.com/). You can set up your own dashboard or,
for the case of usegalaxy.* servers, be added to the
[gxy.io/kui](https://gxy.io/kui) dashboard. Contact Enis Afgan for more
information.

## Usage

Once the environment is configured, you can run the script with the following:

```bash
./kui.sh [YYYY] [MM]
```

where `YYYY` is the year and `MM` is the month for which the data is collected.
If not provided, the script will collect data for the previous month.

### Cron job setup

Edit the crontab file with `crontab -e` and add the following line to run the
script every month:

```bash
0 1 1 * * /path/to/kui.sh
```
