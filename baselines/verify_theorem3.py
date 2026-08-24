#!/usr/bin/env python3
"""
定理 3 完备性穷举验证 (T9)
===========================
枚举 d<=3 的所有未闭合括号栈形态 (JSON 根必为 '{'), 计算每种形态的唯一 LIFO 闭合反序,
检查它是否被五种括号闭合策略之一 (实现同 partial-json-parser.fixed.ts 的 alt1-5) 覆盖。
结论: d<=3 的 8 种形态全部被覆盖 (0 失败), 支撑定理 3。
"""
import itertools

STRATEGIES = {
    # 名称: (闭合序列模板生成)
    # alt1 (策略1): }^needBraces + ]^needBrackets
    # alt2 (策略2): ]^needBrackets + }^needBraces
    # alt3 (策略3): } + ]^needBrackets + }^(needBraces-1)
    # alt4 (策略4): ]^needBrackets
    # alt5 (策略5): }^needBraces
    1: lambda nb, nk: '}' * nb + ']' * nk,
    2: lambda nb, nk: ']' * nk + '}' * nb,
    3: lambda nb, nk: ('}' + ']' * nk + '}' * (nb - 1)) if nb > 0 and nk > 0 else None,
    4: lambda nb, nk: ']' * nk if nk > 0 else None,
    5: lambda nb, nk: '}' * nb if nb > 0 else None,
}
PAIR = {'{': '}', '[': ']'}

def lifo_closing(stack: str) -> str:
    """栈自底(外)向顶(内)排列, LIFO 闭合 = 从顶(内)到底(外)取反括号。"""
    return ''.join(PAIR[c] for c in stack[::-1])

def candidates(nb: int, nk: int):
    toks = []
    for idx in sorted(STRATEGIES):
        s = STRATEGIES[idx](nb, nk)
        if s is not None:
            toks.append((idx, s))
    return toks

def main():
    total, fails, mapping = 0, [], {}
    for d in range(0, 4):
        if d == 0:
            stacks = ['']
        else:
            inner = [''.join(t) for t in itertools.product('{[', repeat=d - 1)]
            stacks = ['{' + t for t in inner]
        for st in stacks:
            nb, nk = st.count('{'), st.count('[')
            lifo = lifo_closing(st)
            cand = candidates(nb, nk)
            hits = [i for i, s in cand if s == lifo]
            mapping[st or '(empty)'] = (lifo, hits)
            total += 1
            status = 'OK ' if hits else 'FAIL'
            print(f'{status} d={d} 栈={st or "(empty)":8} needBraces={nb} needBrackets={nk}  LIFO闭合={lifo!r:8} 覆盖策略={hits}')
            if not hits:
                fails.append(st)
    print()
    print(f'穷举结构数={total}, 未被覆盖={len(fails)}')
    assert not fails, f'定理3反例: {fails}'
    print('结论: d<=3 的 8 种未闭合栈形态均被五种策略之一覆盖, 定理3完备性获穷举支撑。')
    return mapping

if __name__ == '__main__':
    main()