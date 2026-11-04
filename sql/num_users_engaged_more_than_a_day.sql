-- Number of users engaged >1 day for a given month.

-- Need to update desired month range.
-- Runs ~10 minutes.

-- Outputs CSV, eg:

SELECT
    count(DISTINCT user_id) AS user_count
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
                    create_time >= '2023-07-01'
                    AND create_time < '2023-08-01'
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
