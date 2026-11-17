import docx, sys
d = docx.Document()
d.core_properties.author = "Петров Пётр"
p = d.add_paragraph()
p.add_run("Договор оказания услуг № 15/2024-КП между ")
p.add_run("ООО «Ромаш").bold = True
p.add_run("ка» (ИНН 7707083893, КПП 770701001, ОГРН 1027700132195) в лице генерального директора ")
p.add_run("Иванова Ивана Ивановича").italic = True
p.add_run(", и АО «Альфа» в лице Сидоровой А.П.")
d.add_paragraph("Адрес: 125009, г. Москва, ул. Тверская, д. 7, офис 12. Тел.: +7 (495) 123-45-67, email: ivanov@romashka.ru")
t = d.add_table(rows=2, cols=2)
t.cell(0,0).text = "Р/с"; t.cell(0,1).text = "40702810400000012345"
t.cell(1,0).text = "БИК"; t.cell(1,1).text = "БИК 044525225, к/с 30101810400000000225"
d.add_paragraph("Паспорт серия 45 06 № 123456, СНИЛС 112-233-445 95. Карта 4276 3800 1234 5679.")
d.add_paragraph("Подпись: Иванов И.И. Директор ООО «Ромашка» Иванов Иван Иванович.")
d.sections[0].header.paragraphs[0].text = "Конфиденциально — ООО «Ромашка»"
d.save(sys.argv[1])
