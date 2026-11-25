export const demo = `title: Start
---
<<declare $has_key = false>>
档案馆的铁门锁着。值班台上留着一把发条钥匙。
-> 拿起发条钥匙
    <<set $has_key = true>>
    <<jump Door>>
-> 直接检查铁门
    <<jump Door>>
-> 离开档案馆
    <<stop>>
===

title: Door
---
<<if $has_key>>
    铁门上的机芯开始转动。
    -> 转动钥匙
        <<jump Archive>>
    -> 收好钥匙
        钥匙仍在你手里。你退回了大厅。
<<else>>
    锁孔里是一枚齿轮，徒手转不动。
    -> 返回值班台
        <<jump Start>>
    -> 放弃调查
        <<stop>>
<<endif>>
===

title: Archive
---
铁门打开了。你找到了失踪案的原始卷宗。
===
`;
