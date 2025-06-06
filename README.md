# CDC pipeline in GCP from CloudSQL to BigQuery using Debezium.

This tutorial explains how to connect a Postgres instance in Google Cloud Platform to BigQuery using Debezium and Pub/Sub.

This tutorial was made using previous Medium tutorials by [Ajitesh Kumar](https://medium.com/google-cloud/near-real-time-data-replication-using-debezium-on-gke-634ee1d3e1aa) and [Ravish Garg](https://medium.com/nerd-for-tech/debezium-server-to-cloud-pubsub-a-kafka-less-way-to-stream-changes-from-databases-1d6edc97da40). This tutorial attempts to create a careful step by step guide of Ajitesh's instructions, and also for reference for future me.

### Before getting started

To start this project you will need a Google Cloud Platform account. This tutorial was made with the free trial tier of GCP.
Keep in mind this tutorial is compatible with Postgres up to version 13, any newer versions will need a newer version of Debezium.
If you're using Debezium from v2 onwards, you'll need to upgrade the version of Cloud SQL Proxy as well to v2, see the following [GCP Guide to migrating cloud sql proxy](https://github.com/GoogleCloudPlatform/cloud-sql-proxy/blob/main/migration-guide.md).

**Now let's get started**

## Creating the Database in Cloud SQL

To begin with you'll need to create a Cloud SQL instance using Postgres version 13, when creating the database it's important that you enable the following flag to your database: `cloudsql.logical.decoding: on`. 
You can find this configuration in the advanced settings for the creation of a new instance. Proceed with the creation as usual. 

For the purposes of this tutorial, the Cloud SQL instance will be called `postgres13`.

Once the instance has been created, use the sample database created for this instance, which will be named `postgres`. Connect to the database using cloudshell and the following command: `gcloud sql connect postgres13 --user=postgres --quiet`.

After connection, create a simple table with the following configuration:

`CREATE TABLE public.actor (
actor_id integer NOT NULL,
first_name character varying(45) NOT NULL,
last_name character varying(45) NOT NULL,
last_update timestamp without time zone DEFAULT now() NOT NULL
);`

After this, we'll need to create a Cloud SQL superuser, using the following [tutorial](https://www.googlecloudcommunity.com/gc/Databases/CLOUDSQLADMIN-super-user-or-other-super-users-to-be-created/m-p/609742) create a superuser named `debezium_superuser`.

We need to grant this user access to the database, schema and table and also enable Replication. Use the following commands to do so:

`GRANT CONNECT ON DATABASE postgres TO debezium_superuser;`

`GRANT pg_read_all_data TO debezium_superuser;`

`GRANT USAGE ON SCHEMA public TO debezium_superuser;`

`GRANT ALL ON SCHEMA public TO debezium_superuser;`

`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO debezium_superuser;`

`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO debezium_superuser;`

`ALTER USER debezium_superuser REPLICATION;`

The Replication permission allows the user to be able to replicate the information in the database. 
After this is done, we'll move on to create the Google Kubernetes cluster.

## Google Kubernetes Engine
