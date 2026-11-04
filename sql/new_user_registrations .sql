-- Number of new user registrations per month

-- Need to update desired month ranges.
-- Runs instantly.

-- Outputs CSV, eg:
-- 2022-07,2078
-- 2023-06,3057
-- 2023-07,2633

COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(id)
    FROM
        galaxy_user
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
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv;
