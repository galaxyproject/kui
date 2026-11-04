-- Total number of registered users as of given date.

-- By default, the number will be for the last day of the previous month,
-- or manually set a desired date.

-- Runs instantly.

SELECT
    count(id) AS total_registered_users
FROM
    galaxy_user
WHERE
    create_time < date_trunc('month', NOW());
    -- create_time < '2023-08-01';
