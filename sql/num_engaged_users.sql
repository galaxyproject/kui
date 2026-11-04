-- Number of engaged users in a given month (engaged = ran a job).

-- Need to update desired month ranges.
-- Runs ~5 minutes.

-- Outputs CSV, eg:
-- 2022-07,5092
-- 2023-06,6684
-- 2023-07,5555

COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS month,
        COUNT(DISTINCT user_id) AS num_engaged_users
    FROM
        job
    WHERE
        (
            create_time >= '2022-07-01'
            AND create_time < '2022-08-01'
        )
        OR (
            create_time >= '2023-06-01'
            AND create_time < '2023-07-01'
        )
        OR (
            create_time >= '2023-07-01'
            AND create_time < '2023-08-01'
        )
    GROUP BY
        month
    ORDER BY
        month ASC
) TO stdout WITH csv;
