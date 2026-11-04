-- Number of errored jobs per month.

-- Need to update desired month ranges.
-- Runs ~5 minutes.

-- Outputs CSV, eg:
-- 2022-07,153306
-- 2023-06,51067
-- 2023-07,39591

COPY (
    SELECT
        to_char(date_trunc('month', create_time), 'YYYY-MM') AS MONTH,
        COUNT(id) AS num_jobs
    FROM
        job
    WHERE
        state = 'error'
        AND (
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
        )
    GROUP BY
        MONTH
    ORDER BY
        MONTH ASC
) TO stdout WITH csv;
