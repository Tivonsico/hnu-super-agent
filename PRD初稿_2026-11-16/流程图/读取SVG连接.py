#!/usr/bin/env python3
"""只读取 SVG：校验对象、端口、箭头与真实路径，导出连接表。仅用 Python 标准库。"""
import argparse
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

NS = 'http://www.w3.org/2000/svg'
IDENTITY = (1., 0., 0., 1., 0., 0.)
NUMBER = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?'


def multiply(a, b):
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (a0*b0+a2*b1, a1*b0+a3*b1, a0*b2+a2*b3,
            a1*b2+a3*b3, a0*b4+a2*b5+a4, a1*b4+a3*b5+a5)


def transform(value):
    result = IDENTITY
    for name, args in re.findall(r'([A-Za-z]+)\s*\(([^)]*)\)', value or ''):
        v = list(map(float, re.findall(NUMBER, args)))
        if name == 'matrix' and len(v) == 6:
            m = tuple(v)
        elif name == 'translate' and len(v) in (1, 2):
            m = (1, 0, 0, 1, v[0], v[1] if len(v) == 2 else 0)
        elif name == 'scale' and len(v) in (1, 2):
            m = (v[0], 0, 0, v[-1], 0, 0)
        elif name == 'rotate' and len(v) in (1, 3):
            angle = math.radians(v[0]); c, s = math.cos(angle), math.sin(angle)
            m = (c, s, -s, c, 0, 0)
            if len(v) == 3:
                m = multiply(multiply((1, 0, 0, 1, v[1], v[2]), m),
                             (1, 0, 0, 1, -v[1], -v[2]))
        elif name in ('skewX', 'skewY') and len(v) == 1:
            t = math.tan(math.radians(v[0]))
            m = (1, 0, t, 1, 0, 0) if name == 'skewX' else (1, t, 0, 1, 0, 0)
        else:
            raise ValueError(f'不支持的 transform：{name}({args})')
        result = multiply(result, m)
    return result


def point(m, p):
    return (m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5])


def matrices(root):
    result = {}
    def visit(e, parent):
        m = multiply(parent, transform(e.get('transform')))
        result[e] = m
        for child in e:
            visit(child, m)
    visit(root, IDENTITY)
    return result


def path_ends(d):
    """当前连线使用绝对 M/L/Q；兼容 C/H/V。遇到其他命令明确报错。"""
    tokens = re.findall(r'[A-Za-z]|'+NUMBER, d)
    i, command, first, current, tangent = 0, None, None, None, None
    arities = {'M': 2, 'L': 2, 'Q': 4, 'C': 6, 'H': 1, 'V': 1}
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]; i += 1
        if command not in arities:
            raise ValueError(f'连线路径暂不支持 {command!r}，请扩展解析器后再校验')
        n = arities[command]
        values = list(map(float, tokens[i:i+n])); i += n
        if len(values) != n:
            raise ValueError('路径参数不足')
        if command == 'M':
            if first is not None:
                raise ValueError('一条业务边只能有一个连续子路径')
            current = (values[0], values[1]); first = current; command = 'L'
            continue
        if current is None:
            raise ValueError('路径缺少 M')
        end = ((values[0], current[1]) if command == 'H' else
               (current[0], values[0]) if command == 'V' else tuple(values[-2:]))
        previous = tuple(values[-4:-2]) if command in ('Q', 'C') else current
        tangent = (end[0]-previous[0], end[1]-previous[1])
        current = end
    if not first or tangent is None or math.hypot(*tangent) == 0:
        raise ValueError('连线缺少有效方向')
    return first, current, tangent


def near(a, b, tolerance=0.0001):
    return len(a) == len(b) and all(abs(x-y) <= tolerance for x, y in zip(a, b))


def validate(root):
    errors = []
    def check(condition, message):
        if not condition: errors.append(message)
    ids = {}
    for e in root.iter():
        key = e.get('id')
        if key:
            check(key not in ids, f'重复 ID：{key}')
            ids[key] = e
    metadata = ids.get('hnu-graph')
    if metadata is None:
        raise ValueError('SVG 缺少 metadata#hnu-graph，不能用坐标猜测连接关系')
    model = json.loads(metadata.text or '{}')
    check(model.get('schema') == 'hnu-flow-graph/1', '不支持的图模型版本')
    for collection in ('nodes', 'ports', 'edges'):
        keys = [v['id'] for v in model[collection]]
        check(len(keys) == len(set(keys)), f'{collection} 内存在重复 ID')
    nodes = {n['id']: n for n in model['nodes']}
    ports = {p['id']: p for p in model['ports']}
    edges = {e['id']: e for e in model['edges']}
    actual_nodes = {e.get('id') for e in root.iter() if e.get('data-kind') == 'node'}
    actual_ports = {e.get('id') for e in root.iter() if e.get('data-kind') == 'port'}
    actual_edges = {e.get('id') for e in root.iter() if e.get('data-kind') == 'edge'}
    check(actual_nodes == set(nodes), '图模型与 XML 的对象集合不一致')
    check(actual_ports == set(ports), '图模型与 XML 的连接点集合不一致')
    check(actual_edges == set(edges), '图模型与 XML 的业务边集合不一致')
    ms = matrices(root)
    referenced_ports = set()
    # 每个非端口成员必须有可引用 ID，并且只能归属一个已登记对象。
    # 端口由独立的 ports 集合管理，不同时列入 members。
    actual_members = {key: set() for key in nodes}
    for e in root.iter():
        owner = e.get('data-node-id')
        if owner is None or e.get('data-kind') == 'port': continue
        check(owner in nodes, f'对象成员所属对象不存在：{e.get("id", "无 ID")}/{owner}')
        check(bool(e.get('id')), f'对象成员缺少 ID：{owner}')
        if owner in actual_members and e.get('id'):
            actual_members[owner].add(e.get('id'))
    for key, n in nodes.items():
        shape = ids.get(key)
        check(shape is not None, f'对象不存在：{key}')
        if shape is None: continue
        check(shape.get('data-label') == n['label'], f'对象名称不一致：{key}')
        check(shape.get('data-node-type') == n['type'], f'对象类型不一致：{key}')
        check(shape.get('data-parent') == n.get('parent'), f'对象所属模块不一致：{key}')
        check(n.get('parent') is None or n['parent'] in nodes, f'对象所属模块不存在：{key}')
        check(n.get('parent') != key, f'对象不能以自身作为所属模块：{key}')
        check(len(n['members']) == len(set(n['members'])), f'对象成员列表有重复：{key}')
        check(key in n['members'], f'对象成员列表缺少主对象：{key}')
        check(set(n['members']) == actual_members[key], f'对象成员列表不完整或包含多余成员：{key}')
        for member in n['members']:
            e = ids.get(member)
            check(e is not None and e.get('data-node-id') == key and e.get('data-kind') != 'port',
                  f'对象成员引用错误：{key}/{member}')
        # 新图可选择绑定可见标题：labelMember 是 text 的 ID，visibleLabel
        # 可覆盖其期望内容；未提供 visibleLabel 时使用对象的 label。
        if 'labelMember' in n:
            label_id = n['labelMember']
            label_el = ids.get(label_id)
            check(label_id in n['members'] and label_el is not None
                  and label_el.tag == f'{{{NS}}}text', f'对象标题成员无效：{key}')
            expected_label = n.get('visibleLabel', n['label'])
            check(isinstance(expected_label, str), f'对象可见标题必须为文本：{key}')
            if label_el is not None and isinstance(expected_label, str):
                actual_label = ' '.join(''.join(label_el.itertext()).split())
                check(actual_label == ' '.join(expected_label.split()), f'对象可见标题不一致：{key}')
        else:
            check('visibleLabel' not in n, f'对象可见标题缺少 labelMember：{key}')
        for pid in n['ports']:
            check(pid in ports and ports[pid]['node'] == key, f'对象连接点归属错误：{key}/{pid}')
        check(set(n['ports']) == {pid for pid, p in ports.items() if p['node'] == key},
              f'对象连接点列表不完整：{key}')
    # parent 描述逻辑归属，即使 XML 未实际嵌套，也不能形成包含环。
    reported_cycles = set()
    for key in nodes:
        route, positions, current = [], {}, key
        while current in nodes:
            if current in positions:
                cycle = route[positions[current]:]
                signature = frozenset(cycle)
                if signature not in reported_cycles:
                    reported_cycles.add(signature)
                    check(False, '对象所属模块形成循环：'+' → '.join(cycle+[current]))
                break
            positions[current] = len(route); route.append(current)
            current = nodes[current].get('parent')
    for key, p in ports.items():
        e = ids.get(key)
        check(p['node'] in nodes, f'连接点对象不存在：{key}')
        check(e is not None and e.get('data-node-id') == p['node'], f'连接点归属不一致：{key}')
        if e is not None:
            actual = point(ms[e], (float(e.get('cx')), float(e.get('cy'))))
            check(near(actual, (p['x'], p['y'])), f'连接点坐标不一致：{key}')
            check(e.get('data-direction') == p['direction'], f'连接点方向不一致：{key}')
    for key, edge in edges.items():
        path = ids.get(key)
        if path is None:
            errors.append(f'业务边不存在：{key}'); continue
        check(path.tag == f'{{{NS}}}path', f'业务边不是 path：{key}')
        check(edge.get('directed') is True and path.get('data-directed') == 'true', f'业务边不是单向：{key}')
        check(not path.get('marker-start') and not path.get('marker-mid'), f'业务边多余箭头：{key}')
        for role in ('source', 'target'):
            nid, pid = edge[role], edge[role+'Port']
            check(nid in nodes, f'边的对象不存在：{key}/{role}')
            check(pid in ports and ports[pid]['node'] == nid, f'边的连接点归属错误：{key}/{role}')
            if pid in ports:
                check(ports[pid]['direction'] == ('out' if role == 'source' else 'in'),
                      f'边的连接点方向错误：{key}/{role}')
            check(path.get('data-'+role) == nid, f'边的对象引用不一致：{key}/{role}')
            check(path.get('data-'+role+'-port') == pid, f'边的连接点引用不一致：{key}/{role}')
            referenced_ports.add(pid)
        start, end, tangent = path_ends(path.get('d'))
        for role, pos in [('source', start), ('target', end)]:
            port = ports.get(edge[role+'Port'])
            if port:
                check(near(point(ms[path], pos), (port['x'], port['y'])), f'路径端点与连接点不一致：{key}/{role}')
        check(path.get('data-relation') == edge['relation'], f'边的含义不一致：{key}')
        for attribute in ('api', 'boundary'):
            if attribute in edge or path.get('data-'+attribute) is not None:
                expected_attribute = edge.get(attribute)
                if attribute == 'api':
                    check(isinstance(expected_attribute, list)
                          and all(isinstance(v, str) and v for v in expected_attribute),
                          f'边的api应为接口名称数组：{key}')
                    if isinstance(expected_attribute, list):
                        expected_attribute = ','.join(expected_attribute)
                check(path.get('data-'+attribute) == expected_attribute,
                      f'边的{attribute}约定不一致：{key}')
        marker = path.get('marker-end', '')
        marker_id = marker[5:-1] if marker.startswith('url(#') and marker.endswith(')') else ''
        check(marker_id == edge['marker'] and marker_id in ids, f'业务边缺少有效末端箭头：{key}')
        if marker_id in ids:
            marker_el = ids[marker_id]
            check(marker_el.tag == f'{{{NS}}}marker' and marker_el.get('orient') == 'auto',
                  f'箭头必须跟随末段路径方向：{key}')
            check(marker_el.get('refX') == '0' and marker_el.get('refY') == '0'
                  and marker_el.get('markerUnits') == 'userSpaceOnUse' and not marker_el.get('viewBox'),
                  f'箭头坐标约定改变：{key}')
            heads = [v for v in marker_el if v.tag == f'{{{NS}}}path']
            check(len(heads) == 1, f'箭头图形数量错误：{key}')
            if len(heads) == 1:
                values = list(map(float, re.findall(NUMBER, heads[0].get('d', ''))))
                check(len(values) == 6, f'箭头应为三个顶点：{key}')
                if len(values) == 6:
                    check(near(values[:2], (0, 0)), f'箭头尖端没有落在目标连接点：{key}')
                    theta = math.atan2(tangent[1], tangent[0]); cs, sn = math.cos(theta), math.sin(theta)
                    m = ms[path]
                    def root_offset(x, y):
                        rx, ry = cs*x-sn*y, sn*x+cs*y
                        return (m[0]*rx+m[2]*ry, m[1]*rx+m[3]*ry)
                    root_head = [root_offset(*values[i:i+2]) for i in range(0, 6, 2)]
                    tx, ty = root_offset(math.hypot(*tangent), 0)
                    size = math.hypot(tx, ty); ux, uy = tx/size, ty/size
                    for v in root_head[1:]:
                        check(abs(v[0]*ux+v[1]*uy+15) < 0.0001
                              and abs(abs(-v[0]*uy+v[1]*ux)-6) < 0.0001,
                              f'箭头方向或尺寸不一致：{key}')
                    if edge.get('arrowOverlay'):
                        overlay = ids.get(edge['arrowOverlay'])
                        check(overlay is not None and overlay.get('data-edge-id') == key,
                              f'顶层箭头引用错误：{key}')
                        if overlay is not None:
                            values = list(map(float, re.findall(NUMBER, overlay.get('points', ''))))
                            ex, ey = point(m, end)
                            expected = [c for x, y in root_head for c in (ex+x, ey+y)]
                            check(near(values, expected), f'顶层箭头与业务边端点不一致：{key}')
    check(referenced_ports == set(ports), '存在未使用的连接点')
    # 所有带颜色的开放业务路径必须已登记；圆柱、人物和括号均有其他明确类型。
    for e in root.iter():
        if e.tag in {f'{{{NS}}}{t}' for t in ('path', 'line', 'polyline')}:
            check(e.get('data-kind') in ('edge', 'node', 'decoration', 'arrowhead'),
                  f'存在未分类的线条：{e.get("id", "无 ID")}')
    if errors:
        raise ValueError('\n'.join(errors))
    return model


def connections(model):
    nodes = {n['id']: n for n in model['nodes']}
    return [{'id': e['id'], 'source': e['source'], 'sourceLabel': nodes[e['source']]['label'],
             'sourcePort': e['sourcePort'], 'target': e['target'],
             'targetLabel': nodes[e['target']]['label'], 'targetPort': e['targetPort'],
             'relation': e['relation']} for e in model['edges']]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('svg', nargs='?', type=Path,
                   default=Path(__file__).resolve().parent/'05_总体流程图.svg')
    p.add_argument('--format', choices=['summary', 'json', 'markdown'], default='summary')
    p.add_argument('--output', type=Path, help='指定时写入文件；否则输出到终端')
    a = p.parse_args()
    try:
        model = validate(ET.parse(a.svg).getroot())
    except (ValueError, KeyError, TypeError, ET.ParseError) as error:
        print(f'校验失败：{error}', file=sys.stderr); return 1
    if a.format == 'json':
        result = json.dumps(model, ensure_ascii=False, indent=2)
    elif a.format == 'markdown':
        lines = ['# SVG 连接表', '', '由当前 SVG 直接解析；方向按 source → target，不根据颜色或位置推测。', '',
                 '| 边 ID | 起点对象 | 终点对象 | 含义 |', '|---|---|---|---|']
        lines += [f'| `{e["id"]}` | {e["sourceLabel"]} | {e["targetLabel"]} | {e["relation"]} |'
                  for e in connections(model)]
        result = '\n'.join(lines)
    else:
        result = f'校验通过：{len(model["nodes"])} 个对象，{len(model["ports"])} 个连接点，{len(model["edges"])} 条单向边。'
    if a.output:
        a.output.write_text(result+'\n', encoding='utf-8')
    else:
        print(result)
    return 0


if __name__ == '__main__':
    sys.exit(main())
