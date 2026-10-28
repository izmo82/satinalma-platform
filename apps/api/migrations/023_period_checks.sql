-- İnceleme bulgusu: SLA ölçüm dönemi ay bazındadır; aynı ay farklı günle ikinci geçerli ölçüm (ikinci kredi) açılamaz.
ALTER TABLE sla_measurements ADD CONSTRAINT sla_measurements_month_start CHECK (extract(day FROM period_start) = 1);
