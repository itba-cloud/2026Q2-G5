#!/usr/bin/env python3
"""Generate editable Draw.io pages and matching standalone SVGs; no dependencies."""

from pathlib import Path
import base64
import html
from urllib.parse import quote
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".docs/arquitectura"
ICONS = OUT / "aws-icons"
PALETTE = {
    "neutral": ("#ffffff", "#cbd5e1"),
    "group": ("#f8fafc", "#94a3b8"),
    "network": ("#eff6ff", "#93c5fd"),
    "compute": ("#fff7ed", "#fdba74"),
    "data": ("#ecfdf5", "#6ee7b7"),
    "regional": ("#f5f3ff", "#c4b5fd"),
    "pending": ("#fffbeb", "#d97706"),
}


class Page:
    def __init__(self, key, name, height, width=1600):
        self.key, self.name, self.height, self.width = key, name, height, width
        self.boxes, self.edges = [], []

    def box(self, key, x, y, w, h, *lines, kind="neutral", group=False, size=16, **extra):
        self.boxes.append(dict(key=key, x=x, y=y, w=w, h=h, lines=lines,
                               kind=kind, group=group, size=size, **extra))

    def frame(self, key, x, y, w, h, title, *, color, fill="none", icon=None, dashed=False):
        self.box(key, x, y, w, h, title, group=True, size=16,
                 stroke=color, fill=fill, frame=True, group_icon=icon, dashed=dashed)

    def symbol(self, key, x, y, icon, *lines, size=64, caption_width=240):
        self.box(key, x, y, size, size, kind="neutral", icon=icon, symbol=True)
        if lines:
            self.box(key+"-caption", x+size/2-caption_width/2, y+size+7,
                     caption_width, len(lines)*21+6, *lines, size=15, caption=True)

    def edge(self, key, source, target, points, label="", label_at=None,
             color="#475569", dashed=False, both=False):
        self.edges.append(dict(key=key, source=source, target=target,
                               points=points, label=label, label_at=label_at,
                               color=color, dashed=dashed, both=both))

    def render(self, mxfile):
        diagram = ET.SubElement(mxfile, "diagram", id=self.key, name=self.name)
        model = ET.SubElement(diagram, "mxGraphModel", grid="1", gridSize="10",
                              page="1", pageWidth=str(self.width), pageHeight=str(self.height))
        root = ET.SubElement(model, "root")
        ET.SubElement(root, "mxCell", id="0")
        ET.SubElement(root, "mxCell", id="1", parent="0")
        svg = ET.Element("svg", xmlns="http://www.w3.org/2000/svg", width=str(self.width),
                         height=str(self.height), viewBox=f"0 0 {self.width} {self.height}",
                         role="img", **{"aria-labelledby": "title desc"})
        ET.SubElement(svg, "title", id="title").text = self.name
        ET.SubElement(svg, "desc", id="desc").text = (
            "Elastic Worlds Online. Borrador basado en main 06c00a8, 21/10/2026. "
            "Las decisiones y validaciones pendientes se detallan en la documentación.")
        defs = ET.SubElement(svg, "defs")
        for color in sorted({e["color"] for e in self.edges}):
            marker = ET.SubElement(defs, "marker", id="arrow-"+color[1:], viewBox="0 0 10 10",
                               refX="9", refY="5", markerWidth="7", markerHeight="7",
                               orient="auto-start-reverse")
            ET.SubElement(marker, "path", d="M 0 0 L 10 5 L 0 10 z", fill=color)
        ET.SubElement(svg, "rect", width=str(self.width), height=str(self.height), fill="#ffffff")
        # Backgrounds first, connectors next, cards last, in both output formats.
        for box in [b for b in self.boxes if b["group"]]:
            self._box(box, root, svg)
        for edge in self.edges:
            points = edge["points"]
            lookup = {b["key"]: b for b in self.boxes}
            source, target = lookup[edge["source"]], lookup[edge["target"]]
            anchors = (f"exitX={(points[0][0]-source['x'])/source['w']};"
                       f"exitY={(points[0][1]-source['y'])/source['h']};exitPerimeter=0;"
                       f"entryX={(points[-1][0]-target['x'])/target['w']};"
                       f"entryY={(points[-1][1]-target['y'])/target['h']};entryPerimeter=0;")
            cell = ET.SubElement(root, "mxCell", id=edge["key"], parent="1", edge="1",
                                  source=edge["source"], target=edge["target"],
                                  style=("edgeStyle=none;rounded=0;endArrow=block;"
                                         f"strokeColor={edge['color']};strokeWidth=1.6;"
                                         f"startArrow={'block' if edge['both'] else 'none'};"
                                         f"dashed={int(edge['dashed'])};"+anchors))
            geo = ET.SubElement(cell, "mxGeometry", relative="1", **{"as": "geometry"})
            array = ET.SubElement(geo, "Array", **{"as": "points"})
            for x, y in points[1:-1]:
                ET.SubElement(array, "mxPoint", x=str(x), y=str(y))
            ET.SubElement(svg, "polyline", points=" ".join(f"{x},{y}" for x, y in points),
                          fill="none", stroke=edge["color"],
                          **{"stroke-width": "1.6", "stroke-dasharray": "6 5" if edge["dashed"] else "none",
                             "marker-start": f"url(#arrow-{edge['color'][1:]})" if edge["both"] else "none",
                             "marker-end": f"url(#arrow-{edge['color'][1:]})"})
            if edge["label"]:
                x, y = edge["label_at"]
                width = max(80, len(edge["label"]) * 8)
                self._box(dict(key=f'{edge["key"]}-label', x=x-width/2, y=y-12,
                               w=width, h=24, lines=(edge["label"],), kind="neutral",
                               group=False, size=13, label=True), root, svg)
        for box in [b for b in self.boxes if not b["group"]]:
            self._box(box, root, svg)
        ET.indent(svg)
        ET.ElementTree(svg).write(OUT / f"{self.key}.svg", encoding="utf-8", xml_declaration=True)

    @staticmethod
    def _box(b, root, svg):
        x, y, w, h = (b[k] for k in ("x", "y", "w", "h"))
        fill, stroke = PALETTE[b["kind"]]
        fill, stroke = b.get("fill", fill), b.get("stroke", stroke)
        group, label = b["group"], b.get("label", False)
        caption, symbol = b.get("caption", False), b.get("symbol", False)
        lines = b["lines"]
        if symbol:
            Page._image(b["key"], b["icon"], x, y, w, h, root, svg)
            return
        value = "<br>".join((f"<b>{html.escape(line)}</b>" if i == 0 and not label
                                else html.escape(line)) for i, line in enumerate(lines))
        style = (f"rounded={int(not b.get('frame'))};arcSize=8;whiteSpace=wrap;html=1;fillColor={'none' if caption else fill};"
                 f"strokeColor={'none' if label or caption else stroke};fontColor=#0f172a;"
                 f"fontFamily=Arial;fontSize={b['size']};spacing=10;"
                 f"verticalAlign={'top' if group else 'middle'};align={'left' if group else 'center'};"
                 f"dashed={int(b.get('dashed', b['kind'] == 'pending'))};")
        if b.get("group_icon"):
            style += "spacingLeft=45;"
        if b.get("icon"):
            style += "spacingLeft=62;"
        cell = ET.SubElement(root, "mxCell", id=b["key"], parent="1", value=value,
                              vertex="1", style=style)
        ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})
        attrs = dict(x=str(x), y=str(y), width=str(w), height=str(h), rx="0" if b.get("frame") else "10",
                     fill="none" if caption else fill, stroke="none" if label or caption else stroke)
        if b.get("dashed", b["kind"] == "pending"):
            attrs["stroke-dasharray"] = "7 5"
        ET.SubElement(svg, "rect", attrs)
        if b.get("group_icon"):
            Page._image(b["key"]+"-icon", b["group_icon"], x, y, 30, 30, root, svg)
        if b.get("icon"):
            Page._image(b["key"]+"-icon", b["icon"], x+12, y+(h-40)/2, 40, 40, root, svg)
        line_height = b["size"] + 7
        start = y + 27 if group else y + h/2 - (len(lines)-1)*line_height/2 + b["size"]*.35
        for i, line in enumerate(lines):
            ET.SubElement(svg, "text", x=str(x+(45 if b.get('group_icon') else 16) if group else x+w/2+(27 if b.get('icon') else 0)),
                          y=str(start+i*line_height), fill="#0f172a",
                          **{"font-family": "Arial, sans-serif", "font-size": str(b["size"]),
                             "font-weight": "600" if i == 0 and not label else "400",
                             "text-anchor": "start" if group else "middle"}).text = line

    @staticmethod
    def _image(key, icon, x, y, w, h, root, svg):
        data = (ICONS / f"{icon}.svg").read_bytes()
        uri = "data:image/svg+xml," + quote(data.decode(), safe="")
        cell = ET.SubElement(root, "mxCell", id=key, parent="1", vertex="1",
                             style=f"shape=image;imageAspect=0;aspect=fixed;verticalLabelPosition=bottom;image={uri};")
        ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})
        ET.SubElement(svg, "image", x=str(x), y=str(y), width=str(w), height=str(h),
                      href="data:image/svg+xml;base64,"+base64.b64encode(data).decode())


def topology():
    p = Page('red', '01 · Arquitectura AWS', 2040, width=1800)
    p.box('heading', 100, 20, 1600, 55, 'ELASTIC WORLDS ONLINE · ARQUITECTURA AWS', size=23, caption=True)
    p.symbol('players', 653, 105, 'users', 'Jugadores', caption_width=210)
    p.frame('cloud', 45, 245, 1710, 1770, 'AWS Cloud', color='#879196', icon='cloud')
    p.frame('region', 70, 290, 1660, 1700, 'Región · us-east-1', color='#00a4a6', icon='region', dashed=True)
    p.frame('vpc', 100, 355, 1160, 1385, 'VPC · 10.0.0.0/16', color='#8c4fff', icon='vpc')
    for i, x in enumerate((140, 730)):
        az = 'a' if i == 0 else 'b'
        p.frame(f'az-{az}', x, 625, 500, 1025, f'Availability Zone · us-east-1{az}', color='#879196', dashed=True)
        for tier, y, h, offset, title, color, fill, icon in [
            ('public', 670, 190, 0, 'Subred pública', '#7aa116', '#f3f8ec', 'public-subnet'),
            ('private', 1020, 245, 10, 'Subred privada', '#00a4a6', '#eef9fa', 'private-subnet'),
            ('db-subnet', 1300, 150, 20, 'Subred DB', '#3b48cc', '#f3f4fc', 'private-subnet'),
            ('cache-subnet', 1480, 150, 30, 'Subred caché', '#3b48cc', '#f3f4fc', 'private-subnet'),
        ]:
            p.frame(f'{tier}-{az}', x+20, y, 460, h, f'{title} · 10.0.{offset+i}.0/24',
                    color=color, fill=fill, icon=icon)
    p.frame('asg', 210, 710, 970, 145, 'Auto Scaling · WorldHosts', color='#ed7100', icon='asg', dashed=True)
    p.symbol('igw', 653, 390, 'igw')
    p.box('igw-caption', 410, 402, 225, 40, 'Internet Gateway', caption=True, size=15)
    p.symbol('alb', 653, 510, 'alb')
    p.box('alb-caption', 320, 510, 315, 65, 'Application Load Balancer', 'Público', caption=True, size=15)
    p.symbol('world-a', 358, 755, 'ec2', 'Amazon EC2', 'WorldHost A', size=56, caption_width=220)
    p.symbol('world-b', 948, 755, 'ec2', 'Amazon EC2', 'WorldHost B', size=56, caption_width=220)
    p.symbol('internal', 653, 1075, 'alb', 'ALB', 'Interno', size=56, caption_width=145)
    for az, npc_x, metrics_x, eni_x in [('a', 238, 468, 358), ('b', 828, 1058, 948)]:
        p.symbol(f'npc-{az}', npc_x, 1085, 'fargate', 'AWS Fargate', 'NPCService', size=56, caption_width=190)
        p.symbol(f'metrics-{az}', metrics_x, 1085, 'fargate', 'AWS Fargate', 'MetricsService', size=56, caption_width=190)
        p.symbol(f'eni-{az}', eni_x, 1190, 'eni', 'ENI', size=40, caption_width=130)
    p.symbol('rds', 358, 1345, 'rds', 'Amazon RDS', 'PostgreSQL', size=52, caption_width=260)
    p.symbol('redis-a', 358, 1525, 'elasticache', 'Amazon ElastiCache', 'Redis', size=52, caption_width=290)
    p.symbol('redis-b', 948, 1525, 'elasticache', 'Amazon ElastiCache', 'Redis', size=52, caption_width=290)
    p.symbol('gateway', 350, 1670, 'endpoint', size=35)
    p.box('gateway-caption', 400, 1665, 350, 50, 'VPC endpoints', caption=True, size=15)
    for key, y, icon, title, role in [
        ('frontend', 335, 's3', 'Amazon S3', 'Cliente web'),
        ('scheduler', 490, 'scheduler', 'EventBridge Scheduler', None),
        ('workflow', 655, 'step-functions', 'AWS Step Functions', None),
        ('lobby', 820, 'lambda', 'AWS Lambda', 'LobbyService'),
        ('snapshots', 985, 's3', 'Amazon S3', 'Snapshots'),
        ('kinesis', 1150, 'kinesis', 'Amazon Kinesis Data Streams', None),
        ('flink', 1315, 'flink', 'Managed Service for Apache Flink', None),
        ('dynamodb', 1480, 'dynamodb', 'Amazon DynamoDB', None),
        ('secrets', 1645, 'secrets-manager', 'AWS Secrets Manager', None),
    ]:
        p.symbol(key, 1450, y, icon, *([title, role] if role else [title]), caption_width=390)
    for key, x, icon, title, role in [
        ('ecr', 280, 'ecr', 'Amazon ECR', None),
        ('artifacts', 670, 's3', 'Amazon S3', 'Artefactos'),
        ('cloudwatch', 1060, 'cloudwatch', 'Amazon CloudWatch', None),
        ('backend', 1450, 's3', 'Amazon S3', 'Terraform')]:
        p.symbol(key, x, 1810, icon, *([title, role] if role else [title]), size=52, caption_width=320)
    # Only component names are shown in the overview. Protocols, security rules
    # and function responsibilities are documented in .docs/arquitectura/README.md.
    p.edge('users-igw', 'players', 'igw', [(653, 137), (565, 137), (565, 350), (685, 350), (685, 390)])
    p.edge('igw-alb', 'igw', 'alb', [(685, 454), (685, 510)])
    p.edge('users-frontend', 'players', 'frontend', [(717, 137), (1482, 137), (1482, 335)])
    p.edge('users-world-a', 'players', 'world-a', [(653, 137), (120, 137), (120, 783), (358, 783)])
    p.edge('users-world-b', 'players', 'world-b', [(717, 137), (1200, 137), (1200, 783), (1004, 783)])
    p.edge('alb-lobby', 'alb', 'lobby', [(717, 530), (1300, 530), (1300, 840), (1450, 840)], color='#ed7100')
    p.edge('lobby-world-a', 'lobby', 'world-a', [(1450, 852), (1320, 852), (1320, 900), (685, 900), (685, 748), (386, 748), (386, 755)], color='#ed7100', dashed=True)
    p.edge('lobby-world-b', 'lobby', 'world-b', [(1450, 860), (1115, 860), (1115, 800), (1004, 800)], color='#ed7100', dashed=True)
    p.edge('world-internal', 'world-a', 'internal', [(358, 783), (190, 783), (190, 1005), (681, 1005), (681, 1075)], color='#00a4a6')
    p.edge('internal-lobby', 'internal', 'lobby', [(653, 1103), (635, 1103), (635, 1285), (1290, 1285), (1290, 876), (1450, 876)], color='#ed7100')
    p.edge('scheduler-lobby', 'scheduler', 'lobby', [(1514, 522), (1685, 522), (1685, 852), (1514, 852)], color='#ed7100')
    p.edge('lobby-workflow', 'lobby', 'workflow', [(1450, 852), (1390, 852), (1390, 687), (1450, 687)], color='#ed7100', both=True)
    p.edge('lobby-eni-a', 'lobby', 'eni-a', [(1450, 868), (1245, 868), (1245, 1275), (300, 1275), (300, 1210), (358, 1210)], color='#ed7100', dashed=True)
    p.edge('lobby-eni-b', 'lobby', 'eni-b', [(1450, 868), (1245, 868), (1245, 1210), (988, 1210)], color='#ed7100', dashed=True)
    p.edge('lobby-rds', 'lobby', 'rds', [(1450, 880), (1255, 880), (1255, 1290), (205, 1290), (205, 1371), (358, 1371)], color='#8c4fff')
    p.edge('npc-rds', 'npc-a', 'rds', [(266, 1141), (266, 1282), (384, 1282), (384, 1345)], color='#8c4fff')
    p.edge('world-redis', 'world-a', 'redis-a', [(358, 794), (175, 794), (175, 1551), (358, 1551)], color='#7aa116')
    p.edge('redis-replication', 'redis-a', 'redis-b', [(410, 1551), (948, 1551)], color='#7aa116', both=True)
    p.edge('lobby-redis', 'lobby', 'redis-a', [(1450, 880), (1265, 880), (1265, 1470), (440, 1470), (440, 1551), (410, 1551)], color='#7aa116')
    p.edge('world-snapshots', 'world-b', 'snapshots', [(1004, 783), (1220, 783), (1220, 1017), (1450, 1017)], color='#7aa116')
    p.edge('world-kinesis', 'world-b', 'kinesis', [(1004, 791), (1230, 791), (1230, 1182), (1450, 1182)], color='#0073bb')
    p.edge('kinesis-flink', 'kinesis', 'flink', [(1514, 1182), (1685, 1182), (1685, 1347), (1514, 1347)], color='#0073bb')
    p.edge('flink-dynamodb', 'flink', 'dynamodb', [(1450, 1347), (1280, 1347), (1280, 1512), (1450, 1512)], color='#0073bb')
    p.edge('metrics-dynamodb', 'metrics-b', 'dynamodb', [(1114, 1113), (1250, 1113), (1250, 1512), (1450, 1512)], color='#0073bb')
    p.edge('alb-metrics', 'alb', 'metrics-b', [(717, 542), (1165, 542), (1165, 1113), (1114, 1113)], color='#8c4fff')
    p.edge('metrics-internal', 'metrics-a', 'internal', [(524, 1113), (653, 1113)], color='#00a4a6')
    p.edge('lobby-secrets', 'lobby', 'secrets', [(1514, 852), (1710, 852), (1710, 1677), (1514, 1677)], color='#8c4fff')
    return p


def flows():
    p = Page('flujos', '02 · Flujos principales', 1320)
    p.box('heading', 30, 20, 1540, 65, 'ELASTIC WORLDS ONLINE · FLUJOS', size=23, caption=True)
    services = {
        'Cliente': ('users', 'Navegador'),
        'ALB público': ('alb', 'Application Load Balancer'),
        'ALB interno': ('alb', 'Application Load Balancer'),
        'public': ('lambda', 'AWS Lambda'),
        'internal': ('lambda', 'AWS Lambda'),
        'lifecycle': ('lambda', 'AWS Lambda'),
        'maintenance': ('lambda', 'AWS Lambda'),
        'Step Functions': ('step-functions', 'AWS Step Functions'),
        'Scheduler': ('scheduler', 'EventBridge Scheduler'),
        'RDS': ('rds', 'Amazon RDS'),
        'ElastiCache': ('elasticache', 'Amazon ElastiCache'),
        'WorldHost': ('ec2', 'Amazon EC2'),
        'Worlds / NPC': ('ec2', 'Productores'),
        'Snapshots': ('s3', 'Amazon S3'),
        'Kinesis': ('kinesis', 'Amazon Kinesis Data Streams'),
        'Flink': ('flink', 'Managed Flink'),
        'DynamoDB': ('dynamodb', 'Amazon DynamoDB'),
    }
    rows = [
        ('api', '1 · API', ['Cliente', 'ALB público', 'public', 'RDS']),
        ('start', '2 · Inicio / parada', ['public', 'Step Functions', 'lifecycle', 'WorldHost']),
        ('play', '3 · Juego', ['Cliente', 'WorldHost', 'ElastiCache', 'Snapshots']),
        ('control', '4 · API interna', ['WorldHost', 'ALB interno', 'internal', 'RDS']),
        ('telemetry', '5 · Telemetría', ['Worlds / NPC', 'Kinesis', 'Flink', 'DynamoDB']),
        ('maintenance', '6 · Mantenimiento', ['Scheduler', 'maintenance', 'RDS', 'Step Functions']),
    ]
    for index, (key, title, names) in enumerate(rows):
        y = 110 + index*200
        p.box(f'lane-{key}', 30, y, 1540, 180, title, group=True, size=18)
        for i, name in enumerate(names):
            icon, service = services[name]
            lines = [service, name] if name in ('Cliente', 'ALB público', 'ALB interno', 'public', 'internal', 'lifecycle', 'maintenance', 'WorldHost', 'Worlds / NPC', 'Snapshots') else [service]
            p.box(f'{key}-{i}', 60+i*390, y+75, 310, 75, *lines,
                  size=15, icon=icon)
        for i in range(3):
            if key in ('play', 'maintenance') and i == 2:
                continue
            x = 60+i*390
            p.edge(f'{key}-edge-{i}', f'{key}-{i}', f'{key}-{i+1}', [(x+310, y+112), (x+390, y+112)])
        if key in ('play', 'maintenance'):
            p.edge(f'{key}-branch', f'{key}-1', f'{key}-3',
                   [(605, y+150), (605, y+165), (1385, y+165), (1385, y+150)])
    return p



def main():
    OUT.mkdir(parents=True, exist_ok=True)
    mxfile = ET.Element("mxfile", host="app.diagrams.net", version="24.7.17")
    for page in (topology(), flows()):
        page.render(mxfile)
    ET.indent(mxfile)
    ET.ElementTree(mxfile).write(ROOT / "arquitectura-aws.drawio", encoding="utf-8", xml_declaration=True)
    print("Generated arquitectura-aws.drawio and .docs/arquitectura/{red,flujos}.svg")


if __name__ == "__main__":
    main()
