-- Copyright (c) Microsoft Corporation. Licensed under the MIT License.
-- Runs once when the Compose PostgreSQL data volume is initialized.
\getenv reader DB_USER
\getenv reader_password DB_PASSWORD
\getenv database POSTGRES_DB
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', :'reader', :'reader_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'reader') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'reader') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'reader') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'reader') \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'reader') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'reader', '15s') \gexec
SELECT format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', :'reader', '15s') \gexec
