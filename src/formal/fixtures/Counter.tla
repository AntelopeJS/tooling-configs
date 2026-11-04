---- MODULE Counter ----
EXTENDS Naturals

CONSTANT Limit

VARIABLE n

Init == n = 0

Inc == n < Limit /\ n' = n + 1

Reset == n = Limit /\ n' = 0

Next == Inc \/ Reset

Spec == Init /\ [][Next]_n

Small == n <= 1

Bounded == n <= Limit

BelowThree == n < 3

NotTwo == n # 2
====
