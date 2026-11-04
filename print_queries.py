from datetime import datetime
from dateutil.relativedelta import relativedelta

REPORT_CURRENT_MONTH = '2023-09'

current_month_start = datetime.strptime(REPORT_CURRENT_MONTH, "%Y-%m")
current_month_end = current_month_start + relativedelta(months=1)
previous_month_start = current_month_start - relativedelta(months=1)
previous_month_end = previous_month_start + relativedelta(months=1)
previous_year_start = current_month_start - relativedelta(years=1)
previous_year_end = previous_year_start + relativedelta(months=1)


def total_registered_users():
    return f"""
SELECT
    count(id) AS total_registered_users
FROM
    galaxy_user
WHERE
    create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}';

    """


def user_registrations():
    return f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(id) AS user_registrations
    FROM
        galaxy_user
    WHERE
        (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
        )
    GROUP BY
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv header;

    """


def num_engaged_users():
    return f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS month,
        COUNT(DISTINCT user_id) AS num_engaged_users
    FROM
        job
    WHERE
        user_id != 566
        AND (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
        )
    GROUP BY
        month
    ORDER BY
        month ASC
) TO stdout WITH csv header;

    """


def num_users_engaged_more_than_a_day(month_start):
    month_end = month_start + relativedelta(months=1)
    return f"""
SELECT
    count(DISTINCT user_id) AS users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")}
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
                    AND create_time >= '{datetime.strftime(month_start, "%Y-%m-%d")}'
                    AND create_time < '{datetime.strftime(month_end, "%Y-%m-%d")}'
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
    create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}';

    """


def num_jobs_per_month():
    return f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS month,
        COUNT(id) AS num_jobs
    FROM
        job
    WHERE
        user_id != 566
        AND (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
        )
    GROUP BY
        month
    ORDER BY
        month ASC
) TO stdout WITH csv header;

    """


def num_errored_jobs_per_month():
    return f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(id) AS num_error_jobs
    FROM
        job
    WHERE
        state = 'error'
        AND (
            (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
            )
        )
    GROUP BY
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv header;

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
  (a.create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}' AND
  a.create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}' AND
  b.create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}' AND
  b.create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}') OR
  (a.create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}' AND
  a.create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}' AND
  b.create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}' AND
  b.create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}') OR
  (a.create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}' AND
  a.create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}' AND
  b.create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}' AND
  b.create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}');

    """

    num_jobs_by_new_users = f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(job_id) AS num_jobs_by_new_users
    FROM
        new_users_jobs
    WHERE
        (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
        )
    GROUP BY
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv header;

    """

    num_error_jobs_by_new_users = f"""
COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(job_id) AS num_error_jobs_by_new_users
    FROM
        new_users_jobs
    WHERE
        state = 'error'
        AND (
            (
            create_time >= '{datetime.strftime(current_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(current_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_month_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_month_end, "%Y-%m-%d")}'
        )
        OR (
            create_time >= '{datetime.strftime(previous_year_start, "%Y-%m-%d")}'
            AND create_time < '{datetime.strftime(previous_year_end, "%Y-%m-%d")}'
            )
        )
    GROUP BY
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv header;

    """

    def new_users_engaged_more_than_day(month_start):
        month_end = month_start + relativedelta(months=1)
        return f"""
-- ⌄⌄⌄⌄⌄⌄
SELECT
    user_id
INTO TEMP new_users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")}
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
                    create_time >= '{datetime.strftime(month_start, "%Y-%m-%d")}'
                    AND create_time < '{datetime.strftime(month_end, "%Y-%m-%d")}'
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


SELECT
    COUNT(user_id) as num_new_users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")}
FROM
    new_users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")};


SELECT
  COUNT(DISTINCT(j1.job_id)) as num_jobs_by_new_users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")}
FROM
  new_users_jobs j1
JOIN new_users_engaged_more_than_day_{datetime.strftime(month_start, "%Y_%m")} AS j2 ON j1.user_id = j2.user_id;
-- ^^^^^^
"""

    return new_users_job_table + num_jobs_by_new_users + num_error_jobs_by_new_users + \
        new_users_engaged_more_than_day(current_month_start) + \
        new_users_engaged_more_than_day(previous_month_start) + \
        new_users_engaged_more_than_day(previous_year_start)


def main():
    print('\\timing\n',
        total_registered_users(), user_registrations(), num_engaged_users(),
        num_users_engaged_more_than_a_day(current_month_start),
        num_users_engaged_more_than_a_day(previous_month_start),
        num_users_engaged_more_than_a_day(previous_year_start),
        total_num_jobs(),
        num_jobs_per_month(),
        num_errored_jobs_per_month(),
        new_user_queries())

    # print(new_user_queries())
    # print(num_users_engaged_more_than_a_day(current_month_start))

if __name__ == "__main__":
    main()
