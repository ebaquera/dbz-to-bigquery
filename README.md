# CDC pipeline in GCP from CloudSQL to BigQuery using Debezium.

This tutorial explains how to connect a Postgres instance in Google Cloud Platform to BigQuery using Debezium and Pub/Sub.

This tutorial was made using previous Medium tutorials by [Ajitesh Kumar](https://medium.com/google-cloud/near-real-time-data-replication-using-debezium-on-gke-634ee1d3e1aa) and [Ravish Garg](https://medium.com/nerd-for-tech/debezium-server-to-cloud-pubsub-a-kafka-less-way-to-stream-changes-from-databases-1d6edc97da40). This tutorial attempts to create a careful step by step guide of Ajitesh's instructions, and also for reference for future me.

### Before getting started

To start this project you will need a Google Cloud Platform account. This tutorial was made with the free trial tier of GCP.
Keep in mind this tutorial is using [Debezium version 1.7](https://debezium.io/releases/1.7/#compatibility) which is compatible with Postgres up to version 13, any newer versions will need a newer version of Debezium.
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

## Google Kubernetes Engine initial configurations

Moving on, we need to create a cluster in GKE. Create a simple **autopilot** cluster, this enables automatic connection to Workload Identity Federation. Which will be important later.
The creation of the cluster takes a few minutes, in the mean time, upload the 3 main YAML files to the Cloud Shell terminal. You can either upload them using the `nano` command of the text editor in Cloud Shell.

The files will be named `debezium-cm.yaml` for the config map, `debezium_service.yaml` for the service, and `debezium-statefulset.yaml` for the stateful set deployment. Find the files attached to this repositories.
These are 3 of the 4 yaml files needed for this deployment. 

Once the yaml files have been uploaded, we'll need to create a connection between Postgres and GKE. Follow the following [official quickstart guide](https://cloud.google.com/sql/docs/postgres/connect-instance-kubernetes). Skip the intro and begin from "Enable GKE cluster" all the way down to "Set up a service account". You can ignore from "Configure secrets" onwards, this deployment doesn't need secrets and the stateful set yaml file covers the building and deployment.

**Important information:** whenever you need a permission for the Kubernetes service account (`ksa-cloud-sql` as called in the Quickstart guide) you can’t grant privileges to this service account since it won’t appear in the IAM. Instead, you’ll need to grant the permissions to `gke-quickstart-service-account` and then run the policy binding step between the kubernetes service account and the Google service account.

While the cluster is deploying, let's create the Pub/Sub topic.

## Pub/Sub configurations

Create a new topic using the following namesake: `<database>.<schema>.<table>`, in this case the topic will be named `postgres.public.actor`. 

Afterwards create a subscription using the same name schema followed by `-sub`, in this case the subscription is called `postgres.public.actor-sub`. Make sure the subcription type is set to `Pull`.

Grant permissions to `gke-quickstart-service-account` as Pub/Sub publisher using the IAM. After the permission has been granted, be sure to run the policy binding step so both service accounts have the necessary permissions.

## BigQuery configurations

Create a new dataset and table to receive the information. For the purposes of this tutorial, the dataset is named `debezium_test` and the table is named `actor_table`.

The table must have the following schema:

| Field name | Type | Mode |
| ----------| --------- | --------| 
| actor_id | INTEGER | NULLABLE|
| first_name | STRING | NULLABLE |
| last_name | STRING | NULLABLE |
| last_update | TIMESTAMP | NULLABLE |
| _op | STRING | NULLABLE |
| _ts_ms | STRING | NULLABLE |
| _source_ts_ms | STRING | NULLABLE |

The columns are an exact replica of the columns in the postgres database, with some additional columns added for the debezium metadata. These columns are optional but can provide some insights. 

## Deployment

We're ready to deploy in GKE. 

First, connect to the autopilot cluster if not already connected. Then create the namespace in which we'll be working, our namespace will be called `debezium`. Use `kubectl create namespace debezium`. Once it's done, connect to the namespace `kubectl config set-context --current --namespace=debezium`

Let's go ahead and apply all our yaml files using `kubectl apply -f <filename>.yaml`. Deploy the files in the following order:

1. `service-account.yaml`
2. `debezium-cm.yaml`
3. `debezium_service.yaml`
4. `debezium_statefulset.yaml`

Verify the debezium logs using `kubectl logs <pod name> -f`. In our case the pod name is `debezium-gke-0`, verify the pod name with `kubectl get pods`. The `-f` flag allows us to see the logs as they stream.

To ensure the deployment is working look for something like this in the logs: 

`2025-06-04 21:15:48,092 INFO  [io.deb.pip.ChangeEventSourceCoordinator] (debezium-postgresconnector-postgres-change-event-source-coordinator) Snapshot ended with SnapshotResult [status=COMPLETED, offset=PostgresOffsetContext [sourceInfoSchema=Schema{io.debezium.connector.postgresql.Source:STRUCT}, sourceInfo=source_info[server='postgres'db='postgres', lsn=LSN{1/22001DD8}, txId=18186, timestamp=2025-06-04T21:15:48.048Z, snapshot=FALSE, schema=public, table=actor], lastSnapshotRecord=true, lastCompletelyProcessedLsn=null, lastCommitLsn=null, streamingStoppingLsn=null, transactionContext=TransactionContext [currentTransactionId=null, perTableEventCount={}, totalEventCount=0], incrementalSnapshotContext=IncrementalSnapshotContext [windowOpened=false, chunkEndPosition=null, dataCollectionsToSnapshot=[], lastEventKeySent=null, maximumKey=null]]]`

This means Debezium successfully logged to our postgres database and took a snapshot of the current state of our databse. Look for the following log as well:

`2025-06-04 21:15:48,106 INFO  [io.deb.pip.ChangeEventSourceCoordinator] (debezium-postgresconnector-postgres-change-event-source-coordinator) Starting streaming`

This means debezium is ready to stream into Pub/Sub.

`2025-06-04 21:15:48,398 INFO  [io.deb.con.pos.PostgresStreamingChangeEventSource] (debezium-postgresconnector-postgres-change-event-source-coordinator) Searching for WAL resume position
2025-06-05 16:36:28,596 INFO  [io.deb.con.pos.con.WalPositionLocator] (debezium-postgresconnector-postgres-change-event-source-coordinator) First LSN 'LSN{2/B008BE8}' received
2025-06-05 16:36:28,609 INFO  [io.deb.con.pos.PostgresStreamingChangeEventSource] (debezium-postgresconnector-postgres-change-event-source-coordinator) WAL resume position 'LSN{2/B008BE8}' discovered`

These logs show that Debezium is positioned in the last modification in the database and will update from that point onwards.

Now let's test it's working. Simply connect to the database and add a new line to the table using `INSERT INTO public.actor (actor_id, first_name, last_name) VALUES (1, 'test-first', 'test-last');`.

After that, pull the logs from the Pub/Sub subcription to ensure the message has been received. Use `gcloud pubsub subscriptions pull postgres.public.actor-sub --auto-ack --limit=10`. The logs should look like a JSON response:

`DATA: {"schema":{"type":"struct","fields":[{"type":"struct","fields":[{"type":"int32","optional":false,"field":"actor_id"},{"type":"string","optional":false,"field":"first_name"},{"type":"string","optional":false,"field":"last_name"},{"type":"int64","optional":false,"name":"io.debezium.time.MicroTimestamp","version":1,"default":0,"field":"last_update"}],"optional":true,"name":"postgres.public.actor.Value","field":"before"},{"type":"struct","fields":[{"type":"int32","optional":false,"field":"actor_id"},{"type":"string","optional":false,"field":"first_name"},{"type":"string","optional":false,"field":"last_name"},{"type":"int64","optional":false,"name":"io.debezium.time.MicroTimestamp","version":1,"default":0,"field":"last_update"}],"optional":true,"name":"postgres.public.actor.Value","field":"after"},{"type":"struct","fields":[{"type":"string","optional":false,"field":"version"},{"type":"string","optional":false,"field":"connector"},{"type":"string","optional":false,"field":"name"},{"type":"int64","optional":false,"field":"ts_ms"},{"type":"string","optional":true,"name":"io.debezium.data.Enum","version":1,"parameters":{"allowed":"true,last,false"},"default":"false","field":"snapshot"},{"type":"string","optional":false,"field":"db"},{"type":"string","optional":true,"field":"sequence"},{"type":"string","optional":false,"field":"schema"},{"type":"string","optional":false,"field":"table"},{"type":"int64","optional":true,"field":"txId"},{"type":"int64","optional":true,"field":"lsn"},{"type":"int64","optional":true,"field":"xmin"}],"optional":false,"name":"io.debezium.connector.postgresql.Source","field":"source"},{"type":"string","optional":false,"field":"op"},{"type":"int64","optional":true,"field":"ts_ms"},{"type":"struct","fields":[{"type":"string","optional":false,"field":"id"},{"type":"int64","optional":false,"field":"total_order"},{"type":"int64","optional":false,"field":"data_collection_order"}],"optional":true,"field":"transaction"}],"optional":false,"name":"postgres.public.actor.Envelope"},"payload":{"before":null,"after":{"actor_id":2,"first_name":"test","last_name":"test","last_update":1749141388400383},"source":{"version":"1.7.0.Final","connector":"postgresql","name":"postgres","ts_ms":1749141388401,"snapshot":"false","db":"postgres","sequence":"[null,\"8774519784\"]","schema":"public","table":"actor","txId":32501,"lsn":8774519784,"xmin":null},"op":"c","ts_ms":1749141389906,"transaction":null}}
MESSAGE_ID: 15041954339439127
ORDERING_KEY: default
ATTRIBUTES: 
DELIVERY_ATTEMPT: 
ACK_STATUS: SUCCESS`

The log shows that the data was sent by Debezium and acknowledged by Pub/Sub. The data is now streaming!

### Common errors and troubleshooting guides
 - Database user is missing privileges: Be sure to grant permission to all the database, schema and tables. Log in as the superuser to verify you have the required access.
 - Cloud-sql-proxy keeps crashing: this may be an issue with the service account. You should have no issue if you followed the guide, but if problems persist, be sure you grant the cloudsql.viewer permission on the service account. Delete the service account if needed and restart the process.
 - debezium keeps crashing: this may be an issue with the connection to postgres, verify that the superuser has all required access.

Let's get this data onto BigQuery, we'll need to use Dataflow to move it to BigQuery since the subscription is set to `pull` and not `write`.

## Streaming into BigQuery with Dataflow

First, create a Cloud Storage bucket. For this example a simple single region bucket was created, using the region we've been using so far `us-central1`.
After that we'll need to upload the JavaScript UDF Source file. The UDF are the set of instructions used to read the Debezium packages and write the data into BigQuery. The UDF can be done in Python as well, but for this example it's done in JS.
See the attached `debezium_bigquery.js` file.

After upload, we'll need to create a new Dataflow function from Template. Choose any name convenient and select `Pub/Sub to BigQuery` as the template.

Under optional parameters choose:
 - `Input Pub/Sub topic`: leave none, as you need to only specify one of the options.
 - `Input Pub/Sub subscription`: select the subscription we created for this example.
 - The `Target` is the table just created in BigQuery (in our case, actor_table). 
 - In `Cloud Storage path to the JavaScript UDF Source` select the JavaScript UDF Source and file. 
 - Specify the `UDF function name` is `process` as such is the name in the code.
 - `Service Account email`: input the service account email we’ve been using `gke-quickstart-service-account`
 - Use default machine type: you can unselect this option and choose a smaller machine type if so needed. Otherwise if resources are not an issue, leave as is.

Run the job. The job will take a few minutes to validate and run.
Once the job is running correctly and is streaming, you can add a new line or modify any line in the postgres table.
After a few seconds, you should see the streaming data in BigQuery.

Congratulations! You've made a streaming data pipeline using Debezium and Pub/Sub.
