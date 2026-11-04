-- Temp table with jobs by new users only (required for queries lower down)
-- Runs about ~10 minutes.
SELECT
  a.id AS job_id,
  a.create_time,
  a.state,
  a.user_id
INTO TEMP new_users_jobs_2305
FROM
  job a
JOIN
  galaxy_user b ON a.user_id = b.id
WHERE
  a.create_time >= '2023-05-01' AND
  a.create_time < '2023-06-01' AND
  b.create_time >= '2023-05-01' AND
  b.create_time < '2023-06-01';


-- Num jobs by new users
SELECT
  COUNT(job_id) AS jobs_by_new_users
FROM
  new_users_jobs_2305;



-- Num errored jobs by new users
SELECT
  COUNT(job_id) AS err_jobs_by_new_users
FROM
  new_users_jobs_2305
WHERE
  state = 'error';



-- Number of new users that have been engaged >1 day
SELECT
    COUNT(user_id) as num_new_engaged_users
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
                    new_users_jobs_2305
                WHERE
                    create_time >= '2022-07-01'
                    AND create_time < '2022-08-01'
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



-- Number of jobs by new users that have been engaged >1 day
SELECT
  COUNT(DISTINCT(j1.job_id)) as jobs_by_new_engaged_users
FROM
  new_users_jobs_2305 j1
JOIN engaged_users_2305 AS j2 ON j1.user_id = j2.user_id;
