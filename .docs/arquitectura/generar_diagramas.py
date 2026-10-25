"""Genera los diagramas de arquitectura AWS con la libreria `diagrams`.

Requisitos: Graphviz (`dot` en el PATH) y `pip install diagrams`.
Uso: python .docs/arquitectura/generar_diagramas.py

Cada nodo y flecha sale de un recurso o regla de `infra/`; la referencia esta
en el comentario de cada bloque.
"""

from pathlib import Path

from diagrams import Cluster, Diagram, Edge
from diagrams.aws.analytics import KinesisDataAnalytics, KinesisDataStreams
from diagrams.aws.compute import ECR, ElasticContainerService, Fargate, Lambda
from diagrams.aws.database import Dynamodb, ElasticacheForRedis, RDSPostgresqlInstance
from diagrams.aws.general import Users
from diagrams.aws.integration import EventbridgeScheduler, StepFunctions
from diagrams.aws.management import Cloudwatch
from diagrams.aws.network import ElbApplicationLoadBalancer, Endpoint, InternetGateway
from diagrams.aws.security import SecretsManager
from diagrams.aws.storage import SimpleStorageServiceS3
from diagrams.onprem.ci import GithubActions
from diagrams.onprem.iac import Terraform

OUT = Path(__file__).resolve().parent

# Colores de grupo de la guia de iconos de AWS.
CLOUD = {"pencolor": "#232F3E", "bgcolor": "#FFFFFF", "style": "rounded", "penwidth": "2"}
REGION = {"pencolor": "#00A4A6", "bgcolor": "#FFFFFF", "style": "dashed", "penwidth": "1.5"}
VPC = {"pencolor": "#8C4FFF", "bgcolor": "#FFFFFF", "style": "rounded", "penwidth": "2"}
TIER = {"pencolor": "#AAB7B8", "bgcolor": "#FFFFFF", "style": "dashed"}
PUBLIC = {"pencolor": "#7AA116", "bgcolor": "#F2F6E8", "style": "rounded"}
PRIVATE = {"pencolor": "#00A4A6", "bgcolor": "#E6F6F7", "style": "rounded"}
DATA = {"pencolor": "#3F8624", "bgcolor": "#EEF5EC", "style": "rounded"}
PLAIN = {"pencolor": "#AAB7B8", "bgcolor": "#FAFAFA", "style": "rounded"}
LAMBDA = {"pencolor": "#ED7100", "bgcolor": "#FDF2E9", "style": "rounded"}

# Una familia de color por tipo de trafico (ver leyenda).
PLAYER = "#1F6FB2"
CONTROL = "#E07B00"
DATA_EDGE = "#7B2D8E"
TELEMETRY = "#2E8B57"
SUPPORT = "#8A949E"

GRAPH = {
    "fontname": "Arial",
    "fontsize": "30",
    "labelloc": "t",
    "pad": "0.5",
    "nodesep": "0.7",
    "ranksep": "1.1",
    "splines": "ortho",
    "compound": "true",
    "newrank": "true",
}
NODE = {"fontname": "Arial", "fontsize": "13"}
EDGE = {"fontname": "Arial", "fontsize": "12"}

LEGEND = """<
<table border="0" cellborder="0" cellspacing="4" cellpadding="2">
<tr><td colspan="2" align="left"><b>Leyenda</b></td></tr>
<tr><td><table border="0" cellspacing="0" cellpadding="0"><tr><td width="40" height="5" fixedsize="true" bgcolor="#1F6FB2"></td></tr></table></td><td align="left">Jugadores: HTTP a S3 y al ALB público; WebSocket directo a la IP pública de la World task</td></tr>
<tr><td><table border="0" cellspacing="0" cellpadding="0"><tr><td width="40" height="5" fixedsize="true" bgcolor="#E07B00"></td></tr></table></td><td align="left">Control: Scheduler y Step Functions, RunTask en ECS, estado de mundos por el ALB interno</td></tr>
<tr><td><table border="0" cellspacing="0" cellpadding="0"><tr><td width="40" height="5" fixedsize="true" bgcolor="#7B2D8E"></td></tr></table></td><td align="left">Datos: PostgreSQL :5432 y Redis :6379 con TLS, snapshots en S3, réplicas (punteado)</td></tr>
<tr><td><table border="0" cellspacing="0" cellpadding="0"><tr><td width="40" height="5" fixedsize="true" bgcolor="#2E8B57"></td></tr></table></td><td align="left">Telemetría: World tasks y NPC → Kinesis → Flink → DynamoDB → Metrics</td></tr>
<tr><td colspan="2" align="left"> </td></tr>
<tr><td colspan="2" align="left">Una flecha por flota: las de NPC y Metrics salen de la réplica de la AZ a y valen para todas (ECS services de 2 a 4 tasks<br align="left"/>repartidas en private-a y private-b); las de la capa pública valen para todas las World tasks. Punteado: réplicas y lanzamientos.<br align="left"/>Las 5 Lambdas del LobbyService tienen ENI en private-a y private-b; la flecha a RDS desde su recuadro vale para las cinco.<br align="left"/>Sin NAT: las subredes privadas llegan a AWS por VPC endpoints (interface: ECR, Logs, Kinesis, Step Functions, Secrets Manager,<br align="left"/>ECS, EC2; gateway: S3, DynamoDB). Las World tasks salen por su IP pública. Soporte y el detalle de cada flujo: flujos.png.<br align="left"/></td></tr>
</table>>"""


def cluster(label, attrs):
    return Cluster(label, graph_attr={"fontname": "Arial", "fontsize": "14", "margin": "16", **attrs})


def link(color, style="solid", **attrs):
    return Edge(color=color, style=style, penwidth="1.8", **attrs)


def hidden():
    return Edge(style="invis")


def arquitectura():
    with Diagram(
        "Elastic Worlds Online · Arquitectura AWS",
        filename=str(OUT / "arquitectura-aws"),
        outformat="png",
        direction="TB",
        show=False,
        graph_attr=GRAPH,
        node_attr=NODE,
        edge_attr=EDGE,
    ) as diagram:
        players = Users("Jugadores\n(navegador)")

        with cluster("AWS Cloud", CLOUD):
            with cluster("Región us-east-1", REGION):
                # A la izquierda: lo que escriben y leen mundos, NPC y Metrics.
                with cluster("Almacenamiento y telemetría", PLAIN):
                    client = SimpleStorageServiceS3("S3\nCliente web")
                    snapshots = SimpleStorageServiceS3("S3\nSnapshots")
                    kinesis = KinesisDataStreams("Kinesis\nData Streams")
                    flink = KinesisDataAnalytics("Managed Service\nfor Apache Flink")
                    dynamodb = Dynamodb("DynamoDB")

                # main.tf + modules/network: sin NAT, 4 capas x 2 AZ.
                with cluster("VPC 10.0.0.0/16", VPC):
                    igw = InternetGateway("Internet Gateway")
                    # load-balancer.tf: ALB publico en public-a/b.
                    alb = ElbApplicationLoadBalancer("ALB público\nHTTP :80")

                    # worlds-fargate.tf: una task por mundo, IP publica, :8001.
                    with cluster("Capa pública · World tasks (Fargate)", TIER):
                        with cluster("public-a · 10.0.0.0/24 · AZ a", PUBLIC):
                            world_a = Fargate("World task\n(1 por mundo)")
                        with cluster("public-b · 10.0.1.0/24 · AZ b", PUBLIC):
                            world_b = Fargate("World task\n(1 por mundo)")

                    with cluster("Capa privada · aplicación", TIER):
                        # npc-ecs.tf / metrics-ecs.tf: ECS services, 2-4 replicas.
                        with cluster("private-b · 10.0.11.0/24 · AZ b", PRIVATE):
                            npc_b = Fargate("NPC Service")
                            metrics_b = Fargate("Metrics Service")
                        ialb = ElbApplicationLoadBalancer("ALB interno")
                        # modules/lobby: 5 funciones con ENI en private-a/b.
                        with cluster("LobbyService · AWS Lambda", LAMBDA):
                            lb_public = Lambda("public")
                            lb_lifecycle = Lambda("lifecycle")
                            lb_internal = Lambda("internal")
                            lb_maintenance = Lambda("maintenance")
                            lb_migrate = Lambda("migrate\n(solo deploy)")
                        endpoints = Endpoint("VPC endpoints")
                        with cluster("private-a · 10.0.10.0/24 · AZ a", PRIVATE):
                            npc_a = Fargate("NPC Service")
                            metrics_a = Fargate("Metrics Service")

                    # modules/data: RDS Multi-AZ y Redis con dos nodos. Los clientes
                    # usan el endpoint del grupo; el primario puede cambiar de AZ.
                    with cluster("Capa de datos · sin salida a Internet", TIER):
                        with cluster("RDS PostgreSQL · Multi-AZ", PLAIN):
                            with cluster("db-a · 10.0.20.0/24 · AZ a", DATA):
                                rds = RDSPostgresqlInstance("primaria")
                            with cluster("db-b · 10.0.21.0/24 · AZ b", DATA):
                                rds_standby = RDSPostgresqlInstance("standby")
                        with cluster("ElastiCache Redis · 2 nodos, failover", PLAIN):
                            with cluster("redis-a · 10.0.30.0/24 · AZ a", DATA):
                                redis_a = ElasticacheForRedis("nodo")
                            with cluster("redis-b · 10.0.31.0/24 · AZ b", DATA):
                                redis_b = ElasticacheForRedis("nodo")

                # A la derecha, junto al Lobby: lo que lo dispara y lo que lanza.
                with cluster("Orquestación", PLAIN):
                    scheduler = EventbridgeScheduler("EventBridge\nScheduler")
                    sfn = StepFunctions("Step Functions")
                    ecs = ElasticContainerService("ECS\ncluster worlds")
                # Sin flechas: se usan por los VPC endpoints (ver flujos.png).
                with cluster("Soporte", PLAIN):
                    secrets = SecretsManager("Secrets\nManager")
                    ecr = ECR("ECR")
                    cloudwatch = Cloudwatch("CloudWatch")
                    artifacts = SimpleStorageServiceS3("S3\nArtefactos")

        worlds = "cluster_Capa pública · World tasks (Fargate)"
        lobby = "cluster_LobbyService · AWS Lambda"
        database = "cluster_RDS PostgreSQL · Multi-AZ"
        cache = "cluster_ElastiCache Redis · 2 nodos, failover"

        # Las flechas fijan el layout de arriba hacia abajo. Las que suben se
        # escriben con << (arista hacia abajo, punta arriba) para no invertir filas.
        # Una sola flecha por flota: las de NPC y Metrics salen de la replica de
        # la AZ a, y las de la capa publica valen para todas las World tasks.
        # De que World task sale cada una solo cambia el layout: dot acerca cada
        # nodo a sus vecinos, asi que las que van a Orquestacion (izquierda)
        # salen de la AZ a y las que van a telemetria (derecha), de la AZ b.

        # Jugadores (storage.tf, load-balancer.tf, worlds-fargate.tf)
        players >> link(PLAYER) >> client
        players >> link(PLAYER) >> igw
        igw >> link(PLAYER) >> alb
        igw >> link(PLAYER, lhead=worlds, minlen="2") >> world_a
        alb >> link(PLAYER, minlen="2") >> lb_public
        for m in (metrics_a, metrics_b):
            alb >> link(PLAYER, minlen="2") >> m
        world_a << link(PLAYER, style="dashed", ltail=worlds) << npc_a

        # Ciclo de vida de mundos (modules/lobby, workflows/*.asl.json). public,
        # internal y maintenance arrancan workflows; solo lifecycle lanza tasks.
        lb_public >> link(CONTROL) >> sfn
        lb_internal >> link(CONTROL) >> sfn
        lb_maintenance >> link(CONTROL) >> sfn
        lb_lifecycle << link(CONTROL) << sfn
        scheduler >> link(CONTROL) >> lb_maintenance
        lb_lifecycle >> link(CONTROL) >> ecs
        world_a << link(CONTROL, style="dashed", ltail=worlds) << ecs
        world_a >> link(CONTROL, ltail=worlds) >> ialb
        ialb >> link(CONTROL) >> lb_internal

        # Persistencia y chat (modules/data, security.tf)
        # Las flechas terminan en el borde del grupo (endpoint de RDS); cada una
        # se ancla en la base de su lado para no cruzar las columnas. La del
        # recuadro del Lobby vale para las cinco funciones.
        lb_migrate >> link(DATA_EDGE, ltail=lobby, lhead=database) >> rds_standby
        npc_a >> link(DATA_EDGE, lhead=database) >> rds
        rds - link(DATA_EDGE, style="dashed", constraint="false") - rds_standby
        world_a >> link(DATA_EDGE, ltail=worlds, lhead=cache) >> redis_b
        lb_internal >> link(DATA_EDGE, lhead=cache) >> redis_b
        redis_a - link(DATA_EDGE, style="dashed", constraint="false") - redis_b
        world_b >> link(DATA_EDGE, ltail=worlds) >> snapshots

        # Telemetria (modules/telemetry, metrics-ecs.tf)
        world_b >> link(TELEMETRY, ltail=worlds) >> kinesis
        npc_a >> link(TELEMETRY) >> kinesis
        kinesis >> link(TELEMETRY) >> flink >> link(TELEMETRY) >> dynamodb
        metrics_a >> link(TELEMETRY) >> dynamodb
        metrics_a >> link(TELEMETRY) >> ialb

        # Posiciones sin flecha visible: capa de datos debajo de la privada,
        # endpoints en la privada y Soporte debajo de Orquestación.
        # dot ordena cada fila por la mediana de los vecinos de arriba: una
        # arista invisible de los endpoints a db-b la pasaba a la izquierda.
        ialb >> hidden() >> rds >> hidden() >> redis_a
        ecs >> hidden() >> [secrets, ecr]
        secrets >> hidden() >> cloudwatch
        ecr >> hidden() >> artifacts

        # Filas: cada capa en un mismo rango (newrank permite rank=same entre
        # clusters).
        for row in (
            (world_a, world_b),
            (npc_a, metrics_a, npc_b, metrics_b, lb_public, lb_lifecycle),
            (endpoints, ialb, lb_internal, lb_maintenance, lb_migrate),
            (rds, rds_standby),
            (redis_a, redis_b),
        ):
            with diagram.dot.subgraph() as same:
                same.attr(rank="same")
                for node in row:
                    same.node(node._id)
        # Columnas: aristas invisibles pesadas mantienen cada AZ debajo de la
        # anterior, con la a a la izquierda como en la capa pública.
        for column in ((world_a, npc_a, rds, redis_a), (world_b, npc_b, rds_standby, redis_b)):
            for upper, lower in zip(column, column[1:]):
                upper >> Edge(style="invis", weight="20") >> lower

        # diagrams fija el tamaño de todos los nodos; la leyenda usa el de su tabla.
        diagram.dot.node(
            "legend", label=LEGEND, shape="plain", fontname="Arial", fontsize="14",
            fixedsize="false", width="0", height="0", image="", imagescale="false",
        )
        diagram.dot.edge(redis_a._id, "legend", style="invis")


FLOW_GRAPH = {
    "fontname": "Arial",
    "fontsize": "30",
    "labelloc": "t",
    "pad": "0.5",
    "nodesep": "0.5",
    "ranksep": "1.6",
    "splines": "spline",
}


def step(color, label, style="solid"):
    return Edge(color=color, fontcolor=color, label=label, style=style, penwidth="1.8", fontsize="13")


def carril_api():
    # modules/lobby (public), load-balancer.tf, storage.tf
    with cluster("1 · Cliente y API pública", PLAIN):
        browser = Users("Navegador")
        web = SimpleStorageServiceS3("S3\nCliente web")
        alb = ElbApplicationLoadBalancer("ALB público")
        public = Lambda("Lambda\npublic")
        rds = RDSPostgresqlInstance("RDS")
        browser >> step(PLAYER, "HTML, JS y\nruntime-config.js") >> web
        browser >> step(PLAYER, "HTTP :80 /api/*") >> alb
        alb >> step(PLAYER, "target Lambda\n(rutas internas → 403)") >> public
        public >> step(DATA_EDGE, "mundos y\noperaciones") >> rds


def carril_ciclo_de_vida():
    # workflows/*.asl.json, FargateWorldLauncher.js, worlds-fargate.tf
    with cluster("2 · Inicio y parada de un mundo", PLAIN):
        public = Lambda("Lambda\npublic")
        sfn = StepFunctions("Step Functions\nstart / stop world")
        lifecycle = Lambda("Lambda\nlifecycle")
        ecs = ElasticContainerService("ECS\ncluster worlds")
        world = Fargate("World task\npublic-a/b")
        ecr = ECR("ECR")
        rds = RDSPostgresqlInstance("RDS")
        public >> step(CONTROL, "1 · StartExecution") >> sfn
        sfn >> step(CONTROL, "2 · reserve, launch,\nwait, stop") >> lifecycle
        lifecycle >> step(CONTROL, "3 · RunTask / StopTask\n(IP pública por la API de EC2)") >> ecs
        ecs >> step(CONTROL, "4 · task con\nIP pública", style="dashed") >> world
        ecr >> step(SUPPORT, "imagen", style="dashed") >> world
        lifecycle >> step(CONTROL, "5 · health :8001") >> world
        lifecycle >> step(DATA_EDGE, "estado de la\noperación") >> rds


def carril_juego():
    # worlds-fargate.tf, npc-ecs.tf, modules/data, storage.tf
    with cluster("3 · Juego, chat y snapshots", PLAIN):
        browser = Users("Navegador")
        npc = Fargate("NPC Service")
        world = Fargate("World task")
        redis = ElasticacheForRedis("ElastiCache\nRedis")
        snapshots = SimpleStorageServiceS3("S3 Snapshots\n(Glacier IR a 30 días)")
        rds = RDSPostgresqlInstance("RDS")
        browser >> step(PLAYER, "WebSocket :8001\na la IP pública") >> world
        npc >> step(PLAYER, "WebSocket\n(bots)", style="dashed") >> world
        npc >> step(DATA_EDGE, "leases\nde mundos") >> rds
        world >> step(DATA_EDGE, "chat entre mundos\nPub/Sub :6379 TLS") >> redis
        world >> step(DATA_EDGE, "restaura al iniciar,\nguarda cada 30 s") >> snapshots


def carril_api_interna():
    # load-balancer.tf (internal), modules/lobby (internal), security.tf
    with cluster("4 · API interna", PLAIN):
        world = Fargate("World task")
        metrics = Fargate("Metrics Service")
        ialb = ElbApplicationLoadBalancer("ALB interno")
        internal = Lambda("Lambda\ninternal")
        rds = RDSPostgresqlInstance("RDS")
        sfn = StepFunctions("Step Functions")
        redis = ElasticacheForRedis("ElastiCache\nRedis")
        world >> step(CONTROL, "estado, heartbeat,\napagado por inactividad") >> ialb
        metrics >> step(TELEMETRY, "registro de\nmundos") >> ialb
        ialb >> step(CONTROL, "target Lambda") >> internal
        internal >> step(DATA_EDGE, "registro") >> rds
        internal >> step(CONTROL, "stop-world") >> sfn
        internal >> step(DATA_EDGE, "avisos globales") >> redis


def carril_telemetria():
    # modules/telemetry, metrics-ecs.tf, secrets.tf
    with cluster("5 · Telemetría y dashboard", PLAIN):
        world = Fargate("World task")
        npc = Fargate("NPC Service")
        kinesis = KinesisDataStreams("Kinesis\nData Streams")
        artifacts = SimpleStorageServiceS3("S3\nArtefactos")
        flink = KinesisDataAnalytics("Managed Service\nfor Apache Flink")
        dynamodb = Dynamodb("DynamoDB")
        metrics = Fargate("Metrics Service")
        alb = ElbApplicationLoadBalancer("ALB público")
        browser = Users("Navegador")
        secrets = SecretsManager("Secrets\nManager")
        [world, npc] >> step(TELEMETRY, "PutRecords") >> kinesis
        kinesis >> step(TELEMETRY, "muestras") >> flink
        artifacts >> step(SUPPORT, "JAR", style="dashed") >> flink
        flink >> step(TELEMETRY, "último estado por\nmundo y serie de flota") >> dynamodb
        dynamodb >> step(TELEMETRY, "lectura") >> metrics
        browser >> step(PLAYER, "/api/metrics*\nBasic Auth") >> alb
        alb >> step(PLAYER, ":3100") >> metrics
        metrics >> step(SUPPORT, "contraseña", style="dashed") >> secrets


def carril_mantenimiento():
    # modules/lobby (maintenance, monitoring.tf), ReconciliationWorker.js
    with cluster("6 · Mantenimiento programado", PLAIN):
        scheduler = EventbridgeScheduler("EventBridge Scheduler\ncada 1 min")
        maintenance = Lambda("Lambda\nmaintenance")
        rds = RDSPostgresqlInstance("RDS")
        sfn = StepFunctions("Step Functions")
        ecs = ElasticContainerService("ECS")
        cloudwatch = Cloudwatch("CloudWatch\nalarmas")
        scheduler >> step(CONTROL, "concurrencia 1") >> maintenance
        maintenance >> step(DATA_EDGE, "lease y\nreconciliación") >> rds
        maintenance >> step(CONTROL, "sigue y relanza\nworkflows") >> sfn
        maintenance >> step(CONTROL, "tasks huérfanas") >> ecs
        maintenance >> step(SUPPORT, "logs y métricas", style="dashed") >> cloudwatch


def carril_despliegue():
    # .github/workflows, bootstrap.tf, modules/lobby (migrate)
    with cluster("7 · Despliegue", PLAIN):
        actions = GithubActions("GitHub Actions\nDeploy / Destroy")
        terraform = Terraform("Terraform")
        state = SimpleStorageServiceS3("S3\nestado Terraform")
        ecr = ECR("ECR")
        artifacts = SimpleStorageServiceS3("S3\nArtefactos")
        migrate = Lambda("Lambda\nmigrate")
        rds = RDSPostgresqlInstance("RDS")
        actions >> step(SUPPORT, "plan y apply") >> terraform
        terraform >> step(SUPPORT, "backend remoto", style="dashed") >> state
        terraform >> step(SUPPORT, "push de imágenes") >> ecr
        terraform >> step(SUPPORT, "JAR de Flink") >> artifacts
        terraform >> step(SUPPORT, "invoca una vez") >> migrate
        migrate >> step(DATA_EDGE, "migraciones SQL") >> rds


def carril_secretos_y_logs():
    # secrets.tf, modules/data (manage_master_user_password), main.tf (endpoints),
    # log groups de modules/container-workload, modules/lobby y modules/telemetry
    with cluster("8 · Secretos y logs", PLAIN):
        lambdas = Lambda("Lambdas del Lobby\n(las 5)")
        npc = Fargate("NPC Service")
        metrics = Fargate("Metrics Service")
        world = Fargate("World task")
        flink = KinesisDataAnalytics("Managed Service\nfor Apache Flink")
        rds = RDSPostgresqlInstance("RDS")
        terraform = Terraform("Terraform")
        endpoints = Endpoint("VPC endpoints\nsecretsmanager, logs")
        secrets = SecretsManager("Secrets\nManager")
        cloudwatch = Cloudwatch("CloudWatch\nlogs y alarmas")
        lambdas >> step(SUPPORT, "contraseña de RDS") >> endpoints
        npc >> step(SUPPORT, "contraseña de RDS\ny logs") >> endpoints
        metrics >> step(SUPPORT, "contraseña de\nBasic Auth y logs") >> endpoints
        endpoints >> step(SUPPORT, "secretos") >> secrets
        endpoints >> step(SUPPORT, "logs") >> cloudwatch
        lambdas >> step(SUPPORT, "logs (los envía\nel servicio Lambda)") >> cloudwatch
        world >> step(SUPPORT, "logs por su\nIP pública") >> cloudwatch
        flink >> step(SUPPORT, "logs") >> cloudwatch
        rds >> step(SUPPORT, "crea y guarda su\ncontraseña", style="dashed") >> secrets
        terraform >> step(SUPPORT, "contraseña de Metrics\n(no queda en el estado)", style="dashed") >> secrets


CARRILES = [carril_api, carril_ciclo_de_vida, carril_juego, carril_api_interna,
            carril_telemetria, carril_mantenimiento, carril_despliegue,
            carril_secretos_y_logs]


def flujos():
    """Un carril por recorrido; las cajas repetidas son el mismo servicio."""
    with Diagram(
        "Elastic Worlds Online · Flujos principales",
        filename=str(OUT / "flujos"),
        outformat="png",
        direction="LR",
        show=False,
        graph_attr=FLOW_GRAPH,
        node_attr=NODE,
        edge_attr=EDGE,
    ):
        # dot apila los carriles sueltos de abajo hacia arriba: se declaran del
        # ultimo al primero para que el 1 quede arriba.
        for carril in reversed(CARRILES):
            carril()


if __name__ == "__main__":
    arquitectura()
    flujos()
