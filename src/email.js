const nodemailer = require('nodemailer');

function criarEmail({ host, porta = 465, usuario, senha, remetente }) {
  const p = Number(porta || 465);
  const transporte = nodemailer.createTransport({
    host,
    port: p,
    secure: p === 465,
    auth: usuario && senha ? { user: usuario, pass: senha } : undefined,
  });

  return {
    async enviar({ para, assunto, html }) {
      return transporte.sendMail({
        from: remetente,
        to: para,
        subject: assunto,
        html,
      });
    },
  };
}

module.exports = { criarEmail };
