-- Total number of jobs.

-- By default, the count will be up to the last day of the previous month,
-- or manually set a desired date.

-- Runs a couple of minutes.

SELECT
    count(id) AS total_num_jobs
FROM
    job
WHERE
    create_time < date_trunc('month', NOW());
    -- create_time < '2023-08-01';
