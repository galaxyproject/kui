import datetime as dt
import logging
import psycopg2
import sys
from dateutil.relativedelta import relativedelta
from google.cloud import bigquery
from google.api_core import exceptions


file_handler = logging.FileHandler(filename='queries.log')
stdout_handler = logging.StreamHandler(stream=sys.stdout)
handlers = [file_handler, stdout_handler]
logging.basicConfig(
    handlers=handlers,
    level=logging.DEBUG,
    format='%(asctime)s [%(lineno)d]: %(message)s'
)
logger = logging.getLogger('bq_stats')
# Disable 3rd party loggers
logging.getLogger("google.auth._default").disabled = True
logging.getLogger("google.auth.transport.requests").disabled = True
logging.getLogger("google.cloud.bigquery.opentelemetry_tracing").disabled = True
logging.getLogger("urllib3.connectionpool").disabled = True
logging.getLogger("urllib3.util.retry").disabled = True


if len(sys.argv) > 1:
    REPORT_MONTH = sys.argv[1]
    logger.debug(f"Generating report for {REPORT_MONTH}.")
else:
    # Default to previous month
    REPORT_MONTH = dt.datetime.strftime(dt.date.today() - relativedelta(months=1), "%Y-%m")
    logger.debug(f"Generating report for {REPORT_MONTH}.")

current_month_start = dt.datetime.strptime(REPORT_MONTH, "%Y-%m")
current_month_end = current_month_start + relativedelta(months=1)


def total_registered_users():
    return f"""
SELECT
    COUNT(id) AS total_registered_users
FROM
    galaxy_user
WHERE
    create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}';

    """


def user_registrations():
    return f"""
        SELECT
            COUNT(id) AS user_registrations
        FROM
            galaxy_user
        WHERE
            create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
    """


def num_engaged_users():
    return f"""
        SELECT
            COUNT(DISTINCT user_id) AS num_engaged_users
        FROM
            job
        WHERE
            user_id != 566
            AND (
                create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
                AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
            );
    """


def num_users_engaged_more_than_a_day():
    return f"""
        SELECT
            count(DISTINCT user_id) AS users_engaged_more_than_day
        FROM
            (
                SELECT
                    user_id,
                    count(DISTINCT date_group) AS date_group_count
                FROM
                    (
                        SELECT
                            user_id,
                            to_char(create_time, 'YYYY-MM-DD') AS date_group
                        FROM
                            job
                        WHERE
                            user_id != 566
                            AND create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
                            AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
                        GROUP BY
                            user_id,
                            date_group
                        HAVING
                            COUNT(user_id) > 1
                    ) AS user_date_groups
                GROUP BY
                    user_id
                HAVING
                    count(*) > 1
            ) AS users_that_ran_jobs_more_than_1_day;
    """


def total_num_jobs():
    return f"""
        SELECT
            count(id) AS total_num_jobs
        FROM
            job
        WHERE
            create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}';

    """


def num_jobs_per_month():
    return f"""
    SELECT
        COUNT(id) AS num_jobs
    FROM
        job
    WHERE
        user_id != 566
        AND (
            create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
        );
    """


def num_errored_jobs_per_month():
    return f"""
    SELECT
        COUNT(id) AS num_error_jobs
    FROM
        job
    WHERE
        state = 'error'
        AND (
            create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
        );
    """


def new_user_queries():
    new_users_job_table = f"""
        SELECT
            a.id AS job_id,
            a.create_time,
            a.state,
            a.user_id
        INTO TEMP new_users_jobs
        FROM
            job a
        JOIN
            galaxy_user b ON a.user_id = b.id
        WHERE
            a.create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND a.create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
            AND b.create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND b.create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}';
    """

    new_users_engaged_more_than_day = f"""
        SELECT
            user_id
        INTO TEMP new_users_engaged_more_than_day
        FROM
            (
                SELECT
                    user_id,
                    count(DISTINCT date_group) AS date_group_count
                FROM
                    (
                        SELECT
                            user_id,
                            to_char(create_time, 'YYYY-MM-DD') AS date_group
                        FROM
                            new_users_jobs
                        WHERE
                            create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
                            AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
                        GROUP BY
                            user_id,
                            date_group
                        HAVING
                            COUNT(user_id) > 1
                    ) AS user_date_groups
                GROUP BY
                    user_id
                HAVING
                    count(*) > 1
            ) AS users_that_ran_jobs_more_than_1_day;
    """

    new_users_stats = f"""
        WITH num_jobs_by_new_users AS (
            SELECT
                COUNT(job_id) AS num_jobs_by_new_users
            FROM
                new_users_jobs
            WHERE
                create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
                AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
        ), num_error_jobs_by_new_users AS (
            SELECT
                COUNT(job_id) AS num_error_jobs_by_new_users
            FROM
                new_users_jobs
            WHERE
                state = 'error'
                AND (
                    create_time >= '{dt.datetime.strftime(current_month_start, "%Y-%m-%d")}'
                    AND create_time < '{dt.datetime.strftime(current_month_end, "%Y-%m-%d")}'
                )
        ), new_engaged_users AS (
            SELECT
                COUNT(DISTINCT(j2.user_id)) as num_new_users_engaged_more_than_day,
                COUNT(DISTINCT(j1.job_id)) as num_jobs_by_new_users_engaged_more_than_day
            FROM
                new_users_jobs j1
            JOIN new_users_engaged_more_than_day AS j2 ON j1.user_id = j2.user_id
        )
        SELECT
            new_engaged_users.num_new_users_engaged_more_than_day,
            num_jobs_by_new_users.num_jobs_by_new_users,
            new_engaged_users.num_jobs_by_new_users_engaged_more_than_day,
            num_error_jobs_by_new_users.num_error_jobs_by_new_users
        FROM
            num_jobs_by_new_users,
            num_error_jobs_by_new_users,
            new_engaged_users;
    """

    return new_users_job_table + new_users_engaged_more_than_day + new_users_stats


def run_queries():
    users = {}
    jobs = {}

    conn = psycopg2.connect(host="/run/postgresql", database="galaxy_main", user="afgane")
    with conn.cursor() as curs:

        curs.execute(total_registered_users())
        users['total_registered'] = curs.fetchone()[0]
        logger.debug(f"total_registered_users: {users['total_registered']}")

        curs.execute(user_registrations())
        users['monthly_registrations'] = curs.fetchone()[0]
        logger.debug(f"num_new_user_registrations: {users['monthly_registrations']}")

        curs.execute(num_engaged_users())
        users['engaged'] = curs.fetchone()[0]
        logger.debug(f"num_engaged_users: {users['engaged']}")

        curs.execute(num_users_engaged_more_than_a_day())
        users['engaged_day_plus'] = curs.fetchone()[0]
        logger.debug(f"num_users_engaged_more_than_day: {users['engaged_day_plus']}")

        curs.execute(new_user_queries())
        new_users_stats = curs.fetchall()[0]
        users['new_engaged_day_plus'] = new_users_stats[0]
        logger.debug(f"num_new_users_engaged_more_than_day: {users['new_engaged_day_plus']}")

        curs.execute(total_num_jobs())
        jobs['total'] = curs.fetchone()[0]
        logger.debug(f"total_num_jobs: {jobs['total']}")

        curs.execute(num_jobs_per_month())
        jobs['monthly'] = curs.fetchone()[0]
        logger.debug(f"num_jobs_per_month: {jobs['monthly']}")

        jobs['by_new_users'] = new_users_stats[1]
        logger.debug(f"num_jobs_by_new_users: {jobs['by_new_users']}")

        jobs['by_new_users_engaged_day_plus'] = new_users_stats[2]
        logger.debug(f"num_jobs_by_new_users_engaged_more_than_day: {jobs['by_new_users_engaged_day_plus']}")

        curs.execute(num_errored_jobs_per_month())
        jobs['errored'] = curs.fetchone()[0]
        logger.debug(f"num_errored_jobs_per_month: {jobs['errored']}")

        jobs['errored_by_new_users'] = new_users_stats[3]
        logger.debug(f"num_error_jobs_by_new_users: {jobs['errored_by_new_users']}")

    return users, jobs


def push_users_to_bigquery(users):
    bq_client = bigquery.Client()
    table_id = "anvil-cost-modeling.kui.users"
    month = dt.datetime.strftime(current_month_start, "%Y-%m-%d")

    # Check if an entry for the given month already exists
    query = f"SELECT COUNT(month) as month FROM {table_id} WHERE month='{month}'"
    month_entry = bq_client.query(query).to_dataframe()['month'][0]

    if month_entry == 0:
        user_row = [{"month": month, "total_registered": users['total_registered'],
                     "new_registrations": users['monthly_registrations'],
                     "engaged": users['engaged'],
                     "engaged_day_plus": users['engaged_day_plus'],
                     "new_engaged_day_plus": users['new_engaged_day_plus']}]
        errors = bq_client.insert_rows_json(table_id, user_row)
        if errors == []:
            logger.debug(f"New users row added for {month}.")
        else:
            logger.debug(f"Errors encountered while adding a users row: {errors}")
    else:
        logger.debug(f"Users entry for month {month} already exists; updating values.")
        query = f"""
            UPDATE `{table_id}`
            SET total_registered={users['total_registered']}, new_registrations={users['monthly_registrations']},
                engaged={users['engaged']}, engaged_day_plus={users['engaged_day_plus']},
                new_engaged_day_plus={users['new_engaged_day_plus']}
            WHERE
                month='{month}'
        """
        try:
            query_job = bq_client.query(query)
            query_job.result()
        except exceptions.BadRequest as err:
            logger.debug(f"Bad request trying to update users values for {month}: {err}")



def push_jobs_to_bigquery(jobs):
    bq_client = bigquery.Client(project="anvil-cost-modeling")
    table_id = "anvil-cost-modeling.kui.jobs"
    month = dt.datetime.strftime(current_month_start, "%Y-%m-%d")

    # Check if an entry for the given month already exists
    query = f"SELECT COUNT(month) as month FROM {table_id} WHERE month='{month}'"
    month_entry = bq_client.query(query).to_dataframe()['month'][0]

    if month_entry == 0:
        user_row = [{"month": month,
                     "total_jobs": jobs['total'],
                     "month_jobs": jobs['monthly'],
                     "by_new_users": jobs['by_new_users'],
                     "by_new_users_engaged_day_plus": jobs['by_new_users_engaged_day_plus'],
                     "errored": jobs['errored'],
                     'errored_by_new_users': jobs['errored_by_new_users']}]
        errors = bq_client.insert_rows_json(table_id, user_row)
        if errors == []:
            logger.debug(f"New jobs row added for {month}.")
        else:
            logger.debug(f"Errors encountered while adding a jobs row: {errors}")
    else:
        logger.debug(f"Jobs entry for month {month} already exists; updating values.")
        query = f"""
            UPDATE `{table_id}`
            SET total_jobs={jobs['total']},
                month_jobs={jobs['monthly']},
                by_new_users={jobs['by_new_users']},
                by_new_users_engaged_day_plus={jobs['by_new_users_engaged_day_plus']},
                errored={jobs['errored']},
                errored_by_new_users={jobs['errored_by_new_users']}
            WHERE
                month='{month}'
        """
        try:
            query_job = bq_client.query(query)
            query_job.result()
        except exceptions.BadRequest as err:
            logger.debug(f"Bad request trying to update jobs values for {month}: {err}")


def main():
    logger.debug(f"Date range: >={current_month_start} & <{current_month_end}")
    users, jobs = run_queries()
    push_users_to_bigquery(users)
    push_jobs_to_bigquery(jobs)
    logger.debug(f"Done.")
    logging.shutdown()


if __name__ == "__main__":
    main()
