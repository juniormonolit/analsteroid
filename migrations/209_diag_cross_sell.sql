-- 209: узел «кросс-продажа по матрице переходов» (владелец 10.09: «после газобетона кровлю
-- продают в 10% случаев по всей компании — пиздец, у каждых стен есть крыша»). Матрица
-- переходов (features/reports/engine/productMatrix.ts) даёт для каждой категории A самую
-- частую следующую категорию B по компании; узел на менеджера — доля его повторных покупок
-- после A, в которых была B. База — пиры/компания. Лист ветки «повторные».
INSERT INTO diag_nodes (id, name, metric_id, node_kind, subjects, window_kind, controllable, recipient_role, season_adjust, higher_is_better, description, sort_order) VALUES
 ('cross_sell_expected_share', 'Кросс-продажа: доля повторных покупок с ожидаемой категорией', NULL, 'quality', '{manager,branch,company}', 'calendar', 'yes', NULL, false, true,
  'По матрице переходов для каждой категории A известна самая частая следующая категория B по компании (газобетон → кровля). Считаем повторные покупки клиентов менеджера за 12 месяцев: в какой доле после A взяли B. Низко относительно пиров — менеджер не предлагает очевидное продолжение.', 63)
ON CONFLICT (id) DO NOTHING;
INSERT INTO diag_edges (parent_id, child_id, edge_type, lag_kind, lag_transition, weight, status, notes) VALUES
 ('repeat_created_count', 'cross_sell_expected_share', 'hyp', 'none', NULL, 0.7, 'expert', 'матрица переходов: ожидаемая следующая категория'),
 ('repeat_shipments_avg_amount', 'multi_group_order_share', 'hyp', 'none', NULL, 0.5, 'expert', 'допродажа в том же чеке')
ON CONFLICT (parent_id, child_id) DO NOTHING;
