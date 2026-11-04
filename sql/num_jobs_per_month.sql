-- Number of jobs per month.

-- Need to update desired month ranges.
-- Runs ~5 minutes.

-- Outputs CSV, eg:
-- 2022-07,671682
-- 2023-06,516713
-- 2023-07,535709

COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS month,
        COUNT(id) AS num_jobs
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
